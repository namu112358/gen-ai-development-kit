/**
 * 着手宣言の無いセッションの push を見分ける（harness/gates/push-claim.ts が Agent PR の push で App のコメントにして知らせる）。
 * commit の trailer（Claude-Session・Claude の Co-Authored-By）と、push した時点で有効だった着手宣言を比べる。GitHub を呼ばない。
 */
import type { HarnessConfig } from './config.ts';
import { claimOf } from './facts.ts';
import type { IssueComment } from './github.ts';
import type { Claim } from './queue.ts';
import { appRecords } from './state.ts';

/** push された commit の trailer から読んだもの。claude は Claude の印（Claude-Session か Claude の Co-Authored-By）があるか */
export interface CommitSessions {
  claude: boolean;
  sessions: string[];
}

/** 末尾の段落（最後の空行の後）の trailer。段落が1つだけのメッセージは trailer なし */
function trailers(message: string): { key: string; value: string }[] {
  const paragraphs = message.replace(/\r\n/g, '\n').trim().split(/\n\s*\n/);
  if (paragraphs.length < 2) return [];
  return paragraphs.at(-1)!.split('\n').flatMap((line) => {
    const m = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/);
    return m ? [{ key: m[1]!.toLowerCase(), value: m[2]!.trim() }] : [];
  });
}

/** commit メッセージの一覧から、Claude の印とセッション（Claude-Session の値、重複なし）を読む。trailer のキーは大文字と小文字を区別しない */
export function commitSessions(messages: string[]): CommitSessions {
  let claude = false;
  const sessions: string[] = [];
  for (const t of messages.flatMap(trailers)) {
    if (t.key === 'claude-session') {
      claude = true;
      if (!sessions.includes(t.value)) sessions.push(t.value);
    } else if (t.key === 'co-authored-by' && /<noreply@anthropic\.com>/i.test(t.value)) {
      claude = true;
    }
  }
  return { claude, sessions };
}

/** セッションの比べ方をそろえる。URL なら最後の部分を取り、cse_ を session_ に読み替える（agent.ts の sessionUrl と同じ）。それ以外はそのまま */
export function sessionKey(s: string): string {
  if (!s.includes('/')) return s;
  return s.slice(s.lastIndexOf('/') + 1).replace(/^cse_/, 'session_');
}

/** push した時点（pushedAt 以前に作られたコメントだけ）で有効だった着手宣言 */
export function claimAt(comments: IssueComment[], pushedAt: string): Claim | null {
  const at = Date.parse(pushedAt);
  return claimOf(comments.filter((c) => Date.parse(c.created_at) <= at));
}

export type UnclaimedPushReason = 'no-claim' | 'session-mismatch';

/**
 * 知らせる理由。Claude の印が無い commit（人の push）は知らせない。有効な宣言が無ければ no-claim。
 * Claude-Session と、session のある宣言の両方があって、どれとも合わなければ session-mismatch。比べられなければ知らせない。
 */
export function unclaimedPushReason(input: { claims: (Claim | null)[]; commits: CommitSessions }): UnclaimedPushReason | null {
  if (!input.commits.claude) return null;
  const active = input.claims.filter((c): c is Claim => c !== null && !c.released);
  if (active.length === 0) return 'no-claim';
  const claimed = active.flatMap((c) => (c.session ? [sessionKey(c.session)] : []));
  if (input.commits.sessions.length === 0 || claimed.length === 0) return null;
  return input.commits.sessions.some((s) => claimed.includes(sessionKey(s))) ? null : 'session-mismatch';
}

/** 知らせたコメントの記録の kind */
export const UNCLAIMED_PUSH_KIND = 'unclaimed-push';

/** 知らせた記録（kind=unclaimed-push）。セッションは短い形 */
export interface UnclaimedPushRecord {
  version: 1;
  headSha: string;
  reason: UnclaimedPushReason;
  commitSessions: string[];
  claimSessions: string[];
}

/** 同じ head について既に知らせたか */
export function unclaimedPushNotified(config: HarnessConfig, comments: IssueComment[], headSha: string): boolean {
  return appRecords<UnclaimedPushRecord>(config, comments, UNCLAIMED_PUSH_KIND).some((r) => r.value?.headSha === headSha);
}
