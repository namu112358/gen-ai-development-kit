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
  ok: boolean;
  exitCode: 0 | 1;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr ?? '').trim()}`);
  return r.stdout;
}

/** -z の出力を分ける（末尾の空を除く） */
function nulSplit(out: string): string[] {
  return out.split('\0').filter((s) => s !== '');
}

/** base との merge-base から作業ツリーまでの変更（App の changedFiles と同じく、リネームは旧・新の両方）と未追跡のファイル */
export function localChangedFiles(cwd: string, base: string): LocalChanges {
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
  const ok = delegate.usable && delegate.ok;
  return { issue, changed: all, untracked: [...files.untracked].sort(), scope, delegate, ok, exitCode: ok ? 0 : 1 };
}
