// レビューの材料（PR・Closes の Issue・plan-gate 記録の計画・diff・変更ファイル・前回の shadow 記録）を GitHub から集める。
// 前回の shadow 記録は、レビュー用の App の名義（reviewLogin）のコメントだけを読む。previous: false なら PR のコメントを読まず、previous は null（replay.ts の流し直し）。
// harness/lib は写すだけで import せず、Node と Workers の両方で動く。GitHub に書く操作はしない（読むだけ）。
import type { GitHubClient, IssueComment } from './github.ts';
import type { ReviewConfig } from './config.ts';
import { closingIssueNumbers } from './webhook.ts';
import { parseShadowComment, type ShadowRecord } from './record.ts';

export interface MaterialFile {
  path: string;
  content: string;
  truncated: boolean;
  /** 全文を省いた（変更は diff にある）。設定の claude.diffOnlyExtensions に当たる拡張子 */
  diffOnly?: true;
}

export interface Material {
  repository: string;
  pr: { number: number; title: string; body: string; baseRef: string; headSha: string };
  issue: { number: number; title: string; body: string } | null;
  plan: unknown | null;
  diff: string;
  diffTruncated: boolean;
  files: MaterialFile[];
  previous: ShadowRecord | null;
}

// harness/lib/state.ts の appRecords・latestPlanGate、harness/lib/blocks.ts の appMarkKind・extractBlock と同じ条件
// （App の名義・目印の kind が plan-gate・agent-app のフェンスがちょうど1つで JSON が読める。harness/lib は Workers に持ち込まないので写す）。
// 古い順に集めた最後の1件の plan を返す。無い・plan が undefined か null なら null
function latestPlan(comments: IssueComment[], appLogin: string): unknown | null {
  const records: unknown[] = [];
  for (const c of comments) {
    if (c.user?.login !== appLogin) continue;
    if (/<!-- agent-harness:app kind=([\w-]+) -->/.exec(c.body)?.[1] !== 'plan-gate') continue;
    const fences = [...c.body.replace(/\r\n/g, '\n').matchAll(/^(`{3,})[ \t]*agent-app[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm)];
    if (fences.length !== 1) continue;
    try {
      records.push(JSON.parse(fences[0]![2]!));
    } catch {
      continue;
    }
  }
  const last = records.at(-1);
  if (typeof last !== 'object' || last === null) return null;
  const plan = (last as { plan?: unknown }).plan;
  return plan === undefined || plan === null ? null : plan;
}

// 拡張子（大文字・小文字を区別しない末尾一致）が claude.diffOnlyExtensions に当たるか。当たるファイルは全文を読まず diff だけを渡す（Issue #990）
function isDiffOnly(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((e) => lower.endsWith(e.toLowerCase()));
}

// diff の変更ファイル（追加・変更）のパス。diff --git から最初の @@ か次の diff --git までをヘッダーとし、
// その中の `+++ b/<path>` だけを見る（追加した行の本文は hunk の中なので取り違えない）。
// 削除（+++ /dev/null）、+++ の無いもの（バイナリ・名前だけ・モードだけの変更）、引用符で囲まれたパスは除く。重複は1回
function changedPaths(diff: string): string[] {
  const paths: string[] = [];
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
    } else if (line.startsWith('@@')) {
      inHeader = false;
    } else if (inHeader && line.startsWith('+++ b/')) {
      const path = line.slice('+++ b/'.length).split('\t')[0]!.replace(/\r$/, '');
      if (path !== '' && !paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

export async function collectMaterial(
  gh: Pick<GitHubClient, 'getPr' | 'getIssue' | 'listComments' | 'compareDiff' | 'getFileContent'>,
  config: Pick<ReviewConfig, 'claude'>,
  input: { owner: string; repo: string; pr: number; headSha: string; appLogin: string } & (
    | { previous?: true; reviewLogin: string }
    | { previous: false; reviewLogin?: string }
  ),
): Promise<Material> {
  const { maxDiffChars, maxFileChars, diffOnlyExtensions } = config.claude;
  const pr = await gh.getPr(input.pr);

  let issue: Material['issue'] = null;
  let plan: unknown = null;
  const closing = closingIssueNumbers(pr.body);
  if (closing.length === 1) {
    const found = await gh.getIssue(closing[0]!);
    issue = { number: found.number, title: found.title, body: found.body ?? '' };
    plan = latestPlan(await gh.listComments(closing[0]!), input.appLogin);
  }

  const fullDiff = await gh.compareDiff(pr.base.ref, input.headSha);
  const files: MaterialFile[] = [];
  for (const path of changedPaths(fullDiff)) {
    if (isDiffOnly(path, diffOnlyExtensions)) {
      files.push({ path, content: '', truncated: false, diffOnly: true });
      continue;
    }
    const content = await gh.getFileContent(path, input.headSha);
    if (content === null) continue;
    files.push({ path, content: content.slice(0, maxFileChars), truncated: content.length > maxFileChars });
  }

  let previous: ShadowRecord | null = null;
  if (input.previous !== false) {
    for (const c of await gh.listComments(input.pr)) {
      if (c.user?.login !== input.reviewLogin) continue;
      const parsed = parseShadowComment(c.body);
      if (parsed !== null && parsed.headSha !== input.headSha) previous = parsed.record;
    }
  }

  return {
    repository: `${input.owner}/${input.repo}`,
    pr: { number: pr.number, title: pr.title, body: pr.body ?? '', baseRef: pr.base.ref, headSha: input.headSha },
    issue,
    plan,
    diff: fullDiff.slice(0, maxDiffChars),
    diffTruncated: fullDiff.length > maxDiffChars,
    files,
    previous,
  };
}
