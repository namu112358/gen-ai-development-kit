// review-api が使う GitHub REST の薄いクライアント createGitHubClient と、失敗を表す GitHubError。
// fetch を注入できる。読むのは PR・Issue・コメント・diff・ファイルの中身・ツリー、書くのは Issue（PR）へのコメントの作成だけ。
// import は書かない（Node と Workers の両方で型検査が通り、依存を持たないように）。

/** 2xx 以外の応答。message には token・応答本文・ヘッダーを入れない（path はクエリを除いた API のパス） */
export class GitHubError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  constructor(status: number, method: string, path: string) {
    super(`GitHub ${method} ${path} が ${status} で失敗しました`);
    this.name = 'GitHubError';
    this.status = status;
    this.method = method;
    this.path = path;
  }
}

export interface GitHubClientOptions {
  token: string;
  owner: string;
  repo: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: { login: string } | null;
}

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: (string | { name?: string })[];
}

export interface IssueComment {
  id: number;
  body: string;
  user: { login: string } | null;
  author_association: string;
  /** GitHub の応答にある欄（ISO 8601）。偽物や古い呼び出し元には無いことがある */
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}

export interface TreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

export interface Tree {
  sha: string;
  truncated: boolean;
  tree: TreeEntry[];
}

const JSON_ACCEPT = 'application/vnd.github+json';
const PER_PAGE = 100;
const MAX_PAGES = 10;

export function createGitHubClient(opts: GitHubClientOptions) {
  const baseUrl = (opts.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const root = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;

  // 共通の送り口。2xx 以外は GitHubError（getFileContent の 404 は呼び出し側が先に見る）
  const send = async (method: string, path: string, init: { accept?: string; body?: unknown } = {}): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      Accept: init.accept ?? JSON_ACCEPT,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'review-api',
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    const f = opts.fetch ?? globalThis.fetch;
    const res = await f(`${baseUrl}${path}`, body === undefined ? { method, headers } : { method, headers, body });
    if (!res.ok) throw new GitHubError(res.status, method, path.split('?')[0] ?? path);
    return res;
  };

  const getJson = async <T>(path: string): Promise<T> => (await send('GET', path)).json() as Promise<T>;

  return {
    getPr: (n: number): Promise<PullRequest> => getJson<PullRequest>(`${root}/pulls/${n}`),

    getIssue: (n: number): Promise<Issue> => getJson<Issue>(`${root}/issues/${n}`),

    /** コメントを 100 件ずつ読む。100 件未満のページで止め、最大 10 ページで打ち切る */
    async listComments(n: number): Promise<IssueComment[]> {
      const out: IssueComment[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const items = await getJson<IssueComment[]>(`${root}/issues/${n}/comments?per_page=${PER_PAGE}&page=${page}`);
        out.push(...items);
        if (items.length < PER_PAGE) break;
      }
      return out;
    },

    async createComment(n: number, body: string): Promise<IssueComment> {
      const res = await send('POST', `${root}/issues/${n}/comments`, { body: { body } });
      return (await res.json()) as IssueComment;
    },

    /** base と head の3点比較の diff */
    async compareDiff(base: string, head: string): Promise<string> {
      const res = await send('GET', `${root}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
        accept: 'application/vnd.github.diff',
      });
      return res.text();
    },

    /** ファイルの中身。無ければ（404）null */
    async getFileContent(path: string, ref: string): Promise<string | null> {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      try {
        const res = await send('GET', `${root}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
          accept: 'application/vnd.github.raw',
        });
        return await res.text();
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) return null;
        throw error;
      }
    },

    getTree: (ref: string): Promise<Tree> => getJson<Tree>(`${root}/git/trees/${encodeURIComponent(ref)}?recursive=1`),
  };
}

export type GitHubClient = ReturnType<typeof createGitHubClient>;
