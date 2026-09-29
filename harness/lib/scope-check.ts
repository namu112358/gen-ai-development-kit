/**
 * PR を出す前に、ローカルの変更が計画の files に収まるかを確かめる（agent.ts の scope-check、Issue #290）。
 * 照合は App の範囲照合と同じ関数（state.ts の issuePlannedFiles・issueDelegateFiles と scope.ts の checkScope）で行い、決まりを写さない。GitHub は読むだけ。
 */
import { spawnSync } from 'node:child_process';
import type { HarnessConfig } from './config.ts';
import type { GitHub } from './github.ts';
import { checkScope } from './scope.ts';
import { issueDelegateFiles, issuePlannedFiles, latestPlanGate, type PlanGateRecord } from './state.ts';

export interface LocalChanges {
  /** 追跡しているファイルの変更（commit 済み＋未 commit。リネームは旧・新の両方） */
  changed: string[];
  /** 未追跡のファイル（PR にはまだ入っていない） */
  untracked: string[];
}

export interface ScopeCheckReport {
  issue: number;
  /** 照合に使った集合（changed と untracked の和） */
  changed: string[];
  untracked: string[];
  /** agent/scope と同じ照合（ゲートを通った計画） */
  scope: { ok: boolean; outside: string[] } | { missing: string };
  /** 委任承認・bypass の範囲照合。使える計画が無ければ理由と、参考として最新の計画ゲートの記録の計画と照らした範囲の外 */
  delegate: { usable: true; ok: boolean; outside: string[] } | { usable: false; reason: string; latestPlanOutside: string[] | null };
  /** どちらの照合（scope＝agent/scope、delegate＝委任・bypass）で何が起きたか。並びは scope → delegate、各照合の中は no-plan → outside */
  problems: ScopeProblem[];
  /** 終了コードが 0 のときだけ true */
  ok: boolean;
  /**
   * 0：両方の照合に使える計画があり、範囲の外が無い。1：どちらかで範囲の外がある（使える計画が無いときの参考の latestPlanOutside も含む）。
   * 3：範囲の外は無いが、どちらかの照合に使える計画が無い。2 は使わない（agent.ts の fail() が引数・git のエラーで 2 を返すため）
   */
  exitCode: 0 | 1 | 3;
}

export type ScopeProblem =
  | { check: 'scope' | 'delegate'; kind: 'outside'; files: string[] }
  | { check: 'scope' | 'delegate'; kind: 'no-plan'; reason: string };

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

/** -z の出力を分ける（末尾の空を除く） */
function nulSplit(out: string): string[] {
  return out.split('\0').filter((s) => s !== '');
}

/**
 * base との merge-base から作業ツリーまでの変更（App の changedFiles と同じく、リネームは旧・新の両方）と未追跡のファイル。
 * git はリポジトリ（worktree）のルートで走らせ、どのサブディレクトリから呼んでもルートからのパスで返す（ls-files --others は cwd の下だけを cwd からのパスで返すため）
 */
export function localChangedFiles(dir: string, base: string): LocalChanges {
  const cwd = git(dir, ['rev-parse', '--show-toplevel']).trim();
  const mergeBase = git(cwd, ['merge-base', base, 'HEAD']).trim();
  const fields = nulSplit(git(cwd, ['diff', '--name-status', '-M', '-z', mergeBase]));
  const changed = new Set<string>();
  for (let i = 0; i < fields.length; ) {
    const status = fields[i++]!;
    // R・C は旧・新の2つのパスが続く
    const paths = /^[RC]/.test(status) ? 2 : 1;
    for (let k = 0; k < paths; k++) changed.add(fields[i++]!);
  }
  const untracked = new Set(nulSplit(git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])));
  return { changed: [...changed].sort(), untracked: [...untracked].sort() };
}

/** Issue の計画と照らす。GitHub は Issue のコメントを読むだけ */
export async function scopeCheck(gh: GitHub, config: HarnessConfig, issue: number, files: LocalChanges): Promise<ScopeCheckReport> {
  const all = [...new Set([...files.changed, ...files.untracked])].sort();
  const planned = await issuePlannedFiles(gh, config, issue);
  const scope = 'files' in planned ? checkScope(planned.files, all) : { missing: planned.missing };
  const delegatePlanned = await issueDelegateFiles(gh, config, issue);
  let delegate: ScopeCheckReport['delegate'];
  if ('files' in delegatePlanned) {
    const r = checkScope(delegatePlanned.files, all);
    delegate = { usable: true, ok: r.ok, outside: r.outside };
  } else {
    const gate = latestPlanGate(config, await gh.listComments(issue)) as { value: PlanGateRecord & { plan?: { files: string[] } } } | null;
    const latest = gate?.value.plan?.files;
    delegate = { usable: false, reason: delegatePlanned.missing, latestPlanOutside: latest ? checkScope(latest, all).outside : null };
  }
  const problems: ScopeProblem[] = [];
  if ('missing' in scope) problems.push({ check: 'scope', kind: 'no-plan', reason: scope.missing });
  else if (!scope.ok) problems.push({ check: 'scope', kind: 'outside', files: scope.outside });
  if (!delegate.usable) {
    problems.push({ check: 'delegate', kind: 'no-plan', reason: delegate.reason });
    if (delegate.latestPlanOutside?.length) problems.push({ check: 'delegate', kind: 'outside', files: delegate.latestPlanOutside });
  } else if (!delegate.ok) problems.push({ check: 'delegate', kind: 'outside', files: delegate.outside });
  const exitCode = problems.some((p) => p.kind === 'outside') ? 1 : problems.length > 0 ? 3 : 0;
  return { issue, changed: all, untracked: [...files.untracked].sort(), scope, delegate, problems, ok: exitCode === 0, exitCode };
}
