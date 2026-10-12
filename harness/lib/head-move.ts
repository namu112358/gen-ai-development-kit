import { spawnSync } from 'node:child_process';

/**
 * plan-critic の前後の HEAD の比べ方（Issue #784）。同じか、同じブランチのまま origin の既定ブランチに含まれる commit へ早送りされただけなら批評を使い、それ以外は人に返す。
 * 判定は純粋な関数 `classifyHeadMove`（祖先かの確かめは引数で渡す）に置き、git を呼ぶ部分（`readHeadSnapshot`・`gitIsAncestor`）は小さな関数に分けた。
 * 祖先かを確かめられないときは `unknown`（人に返す。安全側）。
 */

/** ある時点の HEAD とブランチ（detach のブランチは空）。repo は控えたときの読み先の絶対パス */
export interface HeadSnapshot {
  head: string;
  branch: string;
  repo?: string;
}

export type HeadMoveVerdict = 'same' | 'fast-forward' | 'branch-changed' | 'not-ancestor' | 'not-in-origin' | 'unknown';

export interface HeadMove {
  verdict: HeadMoveVerdict;
  /** 批評を使ってよいか（same か fast-forward） */
  use: boolean;
  /** fast-forward のときだけ、人がすることの一覧に載せる1行 */
  note: string | null;
}

const result = (verdict: HeadMoveVerdict, note: string | null = null): HeadMove => ({ verdict, use: verdict === 'same' || verdict === 'fast-forward', note });

/**
 * 前後の HEAD を比べる。判定の順：same → branch-changed → not-ancestor → not-in-origin → fast-forward。
 * isAncestor は「ancestor が descendant の祖先（同じ commit を含む）か」を true/false で、確かめられなければ null を返す
 */
export function classifyHeadMove(
  before: HeadSnapshot,
  after: HeadSnapshot,
  originRef: string,
  isAncestor: (ancestor: string, descendant: string) => boolean | null,
): HeadMove {
  if (before.head === after.head && before.branch === after.branch) return result('same');
  if (before.branch !== after.branch) return result('branch-changed');
  const forward = isAncestor(before.head, after.head);
  if (forward === null) return result('unknown');
  if (!forward) return result('not-ancestor');
  const inOrigin = isAncestor(after.head, originRef);
  if (inOrigin === null) return result('unknown');
  if (!inOrigin) return result('not-in-origin');
  return result('fast-forward', `HEAD が早送りされた（${before.head.slice(0, 7)}→${after.head.slice(0, 7)}）`);
}

/** 控えのファイルの中身を読む。JSON でない・head が40桁の16進でない・branch が文字列でないときは errors */
export function parseHeadSnapshot(text: string): { ok: true; value: HeadSnapshot } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`HEAD の控えを JSON として読めません: ${(e as Error).message}`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, errors: ['HEAD の控え: オブジェクトではありません'] };
  const { head, branch, repo } = raw as { head?: unknown; branch?: unknown; repo?: unknown };
  const errors: string[] = [];
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/.test(head)) errors.push('HEAD の控え: head が40桁の16進ではありません');
  if (typeof branch !== 'string') errors.push('HEAD の控え: branch が文字列ではありません');
  if (repo !== undefined && typeof repo !== 'string') errors.push('HEAD の控え: repo が文字列ではありません');
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { head: head as string, branch: branch as string, ...(typeof repo === 'string' ? { repo } : {}) } };
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new Error(`git ${args.join(' ')} を実行できません: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} に失敗しました: ${(r.stderr ?? '').trim()}`);
  return r.stdout.trim();
}

/** cwd の今の HEAD とブランチ（detach のブランチは空）。git が失敗したら投げる */
export function readHeadSnapshot(cwd: string): HeadSnapshot {
  return { head: git(cwd, ['rev-parse', 'HEAD']), branch: git(cwd, ['branch', '--show-current']) };
}

/** `git merge-base --is-ancestor` を cwd で呼ぶ関数。終了コード 0 → true、1 → false、それ以外（commit が手元に無いなど）→ null */
export function gitIsAncestor(cwd: string): (ancestor: string, descendant: string) => boolean | null {
  return (ancestor, descendant) => {
    const r = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, encoding: 'utf8' });
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    return null;
  };
}
