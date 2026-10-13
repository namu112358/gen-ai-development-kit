// Webhook の署名の検証（verifySignature・constantTimeEqual・複数の秘密で試す verifyWithSecrets）と、
// リポジトリの表（repos.ts）でイベントから「レビューするか」を決める decideReview、
// PR 本文の結び付けた Issue の読み取り（linkedIssueNumbers・closingIssueNumbers）。import は ./config.ts の型と ./repos.ts で、Node と Workers の両方で動く。

import type { IssueLink, ReviewConfig } from './config.ts';
import { findRepo, type RepoTable } from './repos.ts';

/** 長さが違えば偽。同じなら全バイトの XOR を OR で積み、途中で抜けない */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** X-Hub-Signature-256 の検証（HMAC-SHA256）。header が `sha256=` と 64 桁の 16進でなければ偽 */
export async function verifySignature(secret: string, rawBody: string | Uint8Array, header: string | null): Promise<boolean> {
  if (header === null || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const encoder = new TextEncoder();
  const body = typeof rawBody === 'string' ? encoder.encode(rawBody) : new Uint8Array(rawBody);
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  const hex = header.slice('sha256='.length);
  const given = new Uint8Array(32);
  for (let i = 0; i < 32; i++) given[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return constantTimeEqual(expected, given);
}

export interface PullRequestEvent {
  action?: string;
  sender?: { type?: string; login?: string };
  repository?: { full_name?: string };
  installation?: { id?: number };
  pull_request?: { head?: { ref?: string }; body?: string | null };
}

/** 空でない値の秘密で署名を試し、通った秘密の名前をすべて返す（無ければ空の配列） */
export async function verifyWithSecrets(
  candidates: { name: string; value: string }[],
  rawBody: string | Uint8Array,
  header: string | null,
): Promise<string[]> {
  const out: string[] = [];
  for (const { name, value } of candidates) {
    if (value === '') continue;
    if (await verifySignature(value, rawBody, header)) out.push(name);
  }
  return out;
}

/**
 * レビューするかを決める。止める理由は順に not-pull-request・action・bot-sender・repo-not-allowed・installation-mismatch・
 * webhook-secret-mismatch（verifiedSecrets が渡され、行の秘密の名前を含まない）・branch-prefix・no-closes、通れば ok。
 * branchPrefix・requireClosesIssue・issueLink は、行の trigger の上書きを config.trigger に重ねて使う
 */
export function decideReview(
  event: PullRequestEvent,
  config: Pick<ReviewConfig, 'trigger'>,
  table: RepoTable,
  verifiedSecrets?: string[],
): { review: boolean; reason: string } {
  const no = (reason: string) => ({ review: false, reason });
  const pr = event.pull_request;
  if (typeof pr !== 'object' || pr === null) return no('not-pull-request');
  if (typeof event.action !== 'string' || !config.trigger.actions.includes(event.action)) return no('action');
  if (config.trigger.skipBotSenders && (event.sender?.type === 'Bot' || (event.sender?.login ?? '').endsWith('[bot]'))) return no('bot-sender');
  const entry = findRepo(table, event.repository?.full_name ?? '');
  if (entry === null) return no('repo-not-allowed');
  const installation = entry.installationId.trim();
  if (installation === '' || event.installation?.id === undefined || String(event.installation.id) !== installation) return no('installation-mismatch');
  if (verifiedSecrets !== undefined && !verifiedSecrets.includes(entry.app.webhookSecret)) return no('webhook-secret-mismatch');
  const t = entry.overrides.trigger ?? {};
  const branchPrefix = t.branchPrefix ?? config.trigger.branchPrefix;
  const requireClosesIssue = t.requireClosesIssue ?? config.trigger.requireClosesIssue;
  const issueLink = t.issueLink ?? config.trigger.issueLink ?? 'closes';
  if (branchPrefix !== '' && !(pr.head?.ref ?? '').startsWith(branchPrefix)) return no('branch-prefix');
  if (requireClosesIssue && linkedIssueNumbers(pr.body ?? null, issueLink).length === 0) return no('no-closes');
  return { review: true, reason: 'ok' };
}

// harness/lib/state.ts の withoutCommentsAndFences と同じ規則（harness/lib は Workers に持ち込まないので写す）
function withoutCommentsAndFences(body: string): string {
  const noComments = body.replace(/<!--[\s\S]*?(-->|$)/g, '');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of noComments.split(/\r?\n/)) {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence === null) {
      if (m) fence = m[1]!;
      else out.push(line);
    } else if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && line.trim() === m[1]) {
      fence = null;
    }
  }
  return out.join('\n');
}

/** PR 本文の閉じる側（Closes・Fixes・Resolves の別形）の `#N`。Refs は返さない。重複は先のものを残し、出てくる順に返す */
export function closingIssueNumbers(body: string | null): number[] {
  return linkedIssueNumbers(body, 'closes');
}

/** PR 本文の結び付けた Issue の `#N`。closes は閉じる側だけ、closes-or-refs は Refs #N も含む。重複は先のものを残し、出てくる順に返す */
export function linkedIssueNumbers(body: string | null, issueLink: IssueLink = 'closes'): number[] {
  if (!body) return [];
  // bodyIssueRefs と同じく、同じ番号は最初に出たキーワードで決める（先に Refs #N があれば、後の Closes #N は閉じる側にしない）
  const seen = new Map<number, boolean>();
  const re = /\b(refs|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+#(\d+)\b/gi;
  for (const m of withoutCommentsAndFences(body).matchAll(re)) {
    const number = Number(m[2]);
    if (number <= 0 || seen.has(number)) continue;
    seen.set(number, m[1]!.toLowerCase() !== 'refs');
  }
  return [...seen].filter(([, closes]) => closes || issueLink === 'closes-or-refs').map(([number]) => number);
}
