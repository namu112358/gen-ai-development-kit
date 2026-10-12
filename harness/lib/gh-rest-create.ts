/**
 * Issue と Draft PR を GraphQL を使わず REST（GitHub.request の POST・GitHub.addLabels）だけで作る（Issue #713）。
 * 守り（保護ラベルと :exempt のラベル、agentBranchPrefix、本文の Closes / Refs、このセッションの着手宣言）は書き込みの前に全部確かめ、
 * 1つでも当たれば GitHub に何も書かずに理由を返す。保護ラベルの一覧は呼び出し元が guard の protectedLabelsOf で作って渡す。
 */
import { ensureOwnClaim } from './claim.ts';
import type { GitHub } from './github.ts';
import { bodyIssueRefs } from './state.ts';

export type CreateResult = { ok: false; errors: string[] } | { ok: true; number: number; url: string };

/** 拒むラベル（入力のまま）。比べ方は guard の isProtectedLabel と同じ（前後の空白を除き大文字・小文字を区別しない、:exempt で終わる）。空のラベルも拒む */
export function rejectedLabels(labels: string[], protectedLabels: string[]): string[] {
  return labels.filter((label) => {
    const l = label.trim().toLowerCase();
    return l === '' || l.endsWith(':exempt') || protectedLabels.some((p) => p.toLowerCase() === l);
  });
}

function labelErrors(labels: string[], protectedLabels: string[]): string[] {
  return rejectedLabels(labels, protectedLabels).map((l) =>
    l.trim() === '' ? '空のラベルは付けられません' : `ラベル ${l} は付けられません（保護ラベルか :exempt のラベル。人か App の役割です）`);
}

export async function restCreateIssue(gh: GitHub, input: { title: string; body: string; labels: string[] }, protectedLabels: string[]): Promise<CreateResult> {
  const errors = labelErrors(input.labels, protectedLabels);
  if (errors.length > 0) return { ok: false, errors };
  const res = await gh.request<{ number: number; html_url: string }>('POST', '/issues', { body: { title: input.title, body: input.body, labels: input.labels } });
  return { ok: true, number: res.number, url: res.html_url };
}

export interface DraftPrInput {
  issue: number;
  head: string;
  base?: string;
  title: string;
  body: string;
  labels: string[];
}

export interface DraftPrOptions {
  /** harness.config.json の agentBranchPrefix */
  prefix: string;
  /** base を省いたときのブランチ */
  defaultBranch: string;
  protectedLabels: string[];
  /** 今のセッションの ID（無ければ null。ensure-claim と同じく止まる） */
  session: string | null;
  /** Assignee の確かめ（ensure-claim と同じ checkAssignee を包んだもの）。止める文か null */
  assignee?: () => Promise<string | null>;
}

/** Draft PR を作る。GitHub を読まずに決まる守り → Issue か（PR でないか）→ 着手宣言 の順に確かめ、通ったときだけ書く */
export async function restCreateDraftPr(gh: GitHub, input: DraftPrInput, opts: DraftPrOptions): Promise<CreateResult & { isDraft?: true }> {
  const errors: string[] = [];
  if (!input.head.startsWith(opts.prefix)) errors.push(`head のブランチ ${input.head} が ${opts.prefix} で始まりません（Agent PR のブランチだけ作れます）`);
  if (!bodyIssueRefs(input.body).some((r) => r.number === input.issue)) errors.push(`本文が #${input.issue} を Closes か Refs していません`);
  errors.push(...labelErrors(input.labels, opts.protectedLabels));
  if (errors.length > 0) return { ok: false, errors };
  // PR の番号だと、Assignee の確かめが PR の Close する Issue の読み（GraphQL）に進むので、先に止める
  const item = await gh.get<{ pull_request?: unknown }>(`/issues/${input.issue}`);
  if (item.pull_request) return { ok: false, errors: [`#${input.issue} は PR です。Issue の番号を渡してください`] };
  const claim = await ensureOwnClaim(gh, input.issue, opts.session, opts.assignee);
  if (claim.error) return { ok: false, errors: [claim.error] };
  const pr = await gh.request<{ number: number; html_url: string }>('POST', '/pulls', {
    body: { title: input.title, head: input.head, base: input.base ?? opts.defaultBranch, body: input.body, draft: true },
  });
  if (input.labels.length > 0) await gh.addLabels(pr.number, input.labels);
  return { ok: true, number: pr.number, url: pr.html_url, isDraft: true };
}
