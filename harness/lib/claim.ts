import { extractBlock, hasClaudeMark, shortSession } from './blocks.ts';
import { claimOf } from './facts.ts';
import type { IssueComment } from './github.ts';
import { claimBlocker, claimHistoryOf, CLAIM_HISTORY_LIMIT, describeClaim, requireOwnClaim, SESSION_ID_MISSING, type Claim, type ClaimEntry, type ClaimStage, type StoredClaim } from './queue.ts';
import { isTrustedComment } from './state.ts';

/**
 * 着手宣言の投稿と読み直し（Issue #171）。最初の宣言が持ち主（facts.ts の claimOf）なので、同時に宣言したら
 * 「投稿 → 少し待つ → 読み直す」で後の側が気づき、自分の宣言を取り下げて止まる。読み直しで気づかなくても、
 * 次の ensureOwnClaim（critic-input・post-plan・worktree・ensure-claim）が同じ決め方で止める。
 * 同じセッションの宣言し直し・解除は、自分の最新の宣言のコメントの書き換え（writeClaim。history に段階を足す。Issue #656）。
 * 引き継ぎ・Routine・書き換えられないときは新しいコメント。
 */

/** 宣言に使う GitHub の操作（GitHub を渡せる。テストでは偽の実装） */
export interface ClaimIo {
  listComments(n: number): Promise<IssueComment[]>;
  comment(n: number, body: string): Promise<unknown>;
  /** 無ければ宣言は新しいコメントのまま（writeClaim） */
  editComment?(commentId: number, body: string): Promise<unknown>;
}

export interface PostClaimOptions {
  /** 今のセッションの ID（無ければ null） */
  current: string | null;
  /** 手動の宣言か（false なら Routine の宣言） */
  manual: boolean;
  /** --takeover：ほかのセッションの宣言から引き継ぐ */
  takeover: boolean;
  stage?: ClaimStage;
  /** 宣言の値からコメントの本文を作る */
  render: (value: StoredClaim) => string;
  /** 投稿の後、読み直す前に待つ（既定は5秒） */
  wait?: () => Promise<void>;
  now: Date;
  humanClaimStaleHours: number;
  /** 宣言の前の確かめ（Assignee・領域の上限など。Issue #172）。文字列を返せば宣言を投稿せず、その文を error として返す */
  before?: () => Promise<string | null>;
}

/** 読み直すまでに待つ時間（同時に書かれたほかのセッションの宣言が一覧に見えるまで） */
export const CLAIM_RECHECK_WAIT_MS = 5_000;

const defaultWait = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, CLAIM_RECHECK_WAIT_MS));

const hasId = (current: string | null): current is string => typeof current === 'string' && current !== '';

/**
 * 宣言のコメントを書く。同じセッション（manual・同じ session）の宣言があれば、その最新のコメントを書き換えて history に段階を足し、
 * 無い・書き換えられない（Routine・takeover・editComment が無い・history が書式違いか上限・PATCH の失敗）ときは新しいコメント。
 * after は書き換える直前に読み直した一覧の最大のコメント ID と、書き換え先の ID、minAfter の最大（post-plan では計画のコメントの ID）。
 */
export async function writeClaim(io: ClaimIo, n: number, value: Claim, opts: { render: (value: StoredClaim) => string; minAfter?: number }): Promise<{ rewritten: boolean }> {
  const fresh = async (): Promise<{ rewritten: boolean }> => {
    await io.comment(n, opts.render(value));
    return { rewritten: false };
  };
  const session = value.session;
  if (value.by !== 'manual' || value.takeover || !io.editComment || typeof session !== 'string' || session === '') return fresh();
  const comments = await io.listComments(n);
  let target: { id: number; value: StoredClaim } | null = null;
  for (const c of comments) {
    if (!hasClaudeMark(c.body) || !isTrustedComment(c) || (target !== null && c.id < target.id)) continue;
    const b = extractBlock(c.body, 'agent-claim');
    const v = b.found && b.ok ? (b.value as StoredClaim) : null;
    if (v !== null && v.by === 'manual' && v.session === session) target = { id: c.id, value: v };
  }
  if (target === null) return fresh();
  let history: ClaimEntry[];
  if (target.value.history === undefined) {
    history = [{ ...(target.value.stage ? { stage: target.value.stage } : {}), ...(target.value.released ? { released: true as const } : {}), at: target.value.at }];
  } else {
    const h = claimHistoryOf(target.value);
    if (h === null) return fresh();
    history = h;
  }
  if (history.length >= CLAIM_HISTORY_LIMIT) return fresh();
  const after = Math.max(target.id, opts.minAfter ?? 0, ...comments.map((c) => c.id));
  const entry: ClaimEntry = { ...(value.stage ? { stage: value.stage } : {}), ...(value.released ? { released: true as const } : {}), at: value.at, after };
  const stored: StoredClaim = {
    by: 'manual',
    session,
    at: value.at,
    ...(value.stage ? { stage: value.stage } : {}),
    ...(value.released ? { released: true as const } : {}),
    ...(target.value.takeover ? { takeover: true as const } : {}),
    history: [...history, entry],
  };
  try {
    await io.editComment(target.id, opts.render(stored));
  } catch {
    return fresh();
  }
  return { rewritten: true };
}

/** 宣言を投稿し、待ってから読み直す。持ち主が自分でなければ取り下げのコメントを書き、先に宣言したセッションを示した error を返す */
export async function postClaim(io: ClaimIo, n: number, opts: PostClaimOptions): Promise<{ error: string | null }> {
  const { current } = opts;
  if (!hasId(current)) return { error: `#${n}: ${SESSION_ID_MISSING}` };
  const stop = opts.before ? await opts.before() : null;
  if (stop) return { error: stop };
  const blocker = claimBlocker(claimOf(await io.listComments(n)), current, { takeover: opts.takeover, now: opts.now, humanClaimStaleHours: opts.humanClaimStaleHours });
  if (blocker) return { error: `#${n}: ${blocker}` };

  const at = opts.now.toISOString();
  const stage = opts.stage ? { stage: opts.stage } : {};
  const value: Claim = opts.manual
    ? { by: 'manual', at, session: current, ...stage, ...(opts.takeover ? { takeover: true as const } : {}) }
    : { by: 'routine', session: current, at, ...stage, ...(opts.takeover ? { takeover: true as const } : {}) };
  await writeClaim(io, n, value, { render: opts.render });
  await (opts.wait ?? defaultWait)();

  const owner = claimOf(await io.listComments(n));
  if (owner && owner.by === value.by && owner.session === current) return { error: null };
  const { takeover: _takeover, ...rest } = value;
  await writeClaim(io, n, { ...rest, released: true }, { render: opts.render });
  const who = owner ? describeClaim(owner) : '';
  return { error: `#${n}: 先に宣言したセッションがあるため、この宣言を取り下げました${who ? `（${who}）` : ''}。この Issue は進めず、引き継ぐかは人が決めてください（引き継ぐなら --takeover）` };
}

/** 宣言が成功したときに出す1行（番号・段階・session の短い ID） */
export function claimedLine(n: number, stage: ClaimStage | undefined, session: string): string {
  return `#${n}: 着手を宣言しました（段階 ${stage ?? 'なし'}・session ${shortSession(session)}）`;
}

/**
 * このセッションの有効な宣言（持ち主）があるか。無ければ error。
 * assignee を渡すと、持ち主が自分のときに続けて呼び、文字列を返せばその文を error にする（宣言の後に Assignee が変わった場合。Issue #172）
 */
export async function ensureOwnClaim(io: Pick<ClaimIo, 'listComments'>, n: number, current: string | null, assignee?: () => Promise<string | null>): Promise<{ error: string | null }> {
  const r = requireOwnClaim(claimOf(await io.listComments(n)), current);
  if (r.error) return { error: `#${n}: ${r.error}` };
  const stop = assignee ? await assignee() : null;
  return { error: stop || null };
}
