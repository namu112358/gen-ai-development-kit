import { readFileSync } from 'node:fs';
import { autoModeConfig, autoModeState } from '../../../lib/auto-mode.ts';
import { LABELS, patrolAutoSupplyConfig, type HarnessConfig } from '../../../lib/config.ts';
import type { GitHub } from '../../../lib/github.ts';
import { autoSupplyReady, autoSupplySourceRef, parseAutoSupplyCandidates, selectAutoSupply, type AutoSupplyIssue } from '../../../lib/patrol.ts';
import { findDashboard, hasLabel, timeline } from '../../../lib/state.ts';
import { type AgentCommand, config, fail } from '../cli.ts';

/**
 * patrol が auto mode の間に下書きを自動で Issue にする供給の、数の確認と agent:ready の付与（Issue #828）。GitHub は REST だけで読み、書くのは ready の POST 1回だけ。
 *
 *   node harness/scripts/agent.ts patrol-supply check <候補の JSON>
 *                                                           候補を読み、auto mode の状態と直近 24 時間の自動の Issue の数から、自動で Issue にするもの（create）と人の側に残すもの（manual）を JSON で出す。GitHub には書かない
 *   node harness/scripts/agent.ts patrol-supply ready <番号>
 *                                                           selectAutoSupply と同じ条件（autoSupplyReady）を満たすときだけ、その Issue に agent:ready を付ける。標準出力に { issue, ready, reasons, added }
 *
 * auto mode の読み方は harness/gates/auto-mode.ts の autoModeFor と同じ。ダッシュボードか timeline が読めないときは無効として扱う。
 * 付けるラベルは agent:ready だけ。
 */

const USAGE = 'patrol-supply check <候補の JSON> | patrol-supply ready <番号>';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PAGES = 3;

interface IssueRow {
  number: number;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  labels?: ({ name?: string } | string)[];
  pull_request?: unknown;
}

/** auto mode の今の状態（autoModeFor と同じ読み方）。ダッシュボードか timeline が読めなければ無効 */
async function readAutoMode(gh: GitHub, cfg: HarnessConfig): Promise<{ active: boolean; reason: string }> {
  try {
    const found = await findDashboard(gh, cfg);
    const state = !found || !hasLabel(found, autoModeConfig(cfg).label) ? autoModeState(found, [], cfg) : autoModeState(found, await timeline(gh, found.number), cfg);
    return { active: state.active, reason: state.reason };
  } catch {
    return { active: false, reason: 'ダッシュボードか timeline が読めない' };
  }
}

export function toAutoSupplyIssue(row: IssueRow): AutoSupplyIssue {
  return {
    number: row.number,
    body: row.body ?? '',
    author: row.user?.login ?? '',
    createdAt: row.created_at ?? '',
    labels: (row.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
    pullRequest: row.pull_request !== undefined && row.pull_request !== null,
  };
}

/** 自分が作った直近の Issue。since は更新の時刻での絞り込みなので、24 時間以内に作った Issue は含まれる */
async function recentIssues(gh: GitHub, self: string, now: Date): Promise<AutoSupplyIssue[]> {
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const q = new URLSearchParams({ state: 'all', creator: self, since, sort: 'created', direction: 'desc' });
  return (await gh.paginate<IssueRow>(`/issues?${q.toString()}`, MAX_PAGES)).map(toAutoSupplyIssue);
}

/** 目印があり、自分が作った、24 時間以内の、PR でない Issue の数（autoSupplyReady の数え方と同じ条件） */
export function countRecentAutoSupply(recent: AutoSupplyIssue[], self: string, now: Date): number {
  return recent.filter((i) => {
    const at = Date.parse(i.createdAt);
    return !i.pullRequest && autoSupplySourceRef(i.body) !== null && i.author === self && Number.isFinite(at) && at <= now.getTime() && now.getTime() - at <= DAY_MS;
  }).length;
}

/** 読めないものは上限が決まらないので、何も書かずに止まる */
async function readOrFail<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    return fail([`${what}が読めません：${(e as Error).message}`]);
  }
}

export const commands: AgentCommand[] = [
  {
    name: 'patrol-supply',
    run: async (args, ctx) => {
      const [sub, arg, ...rest] = args;
      if ((sub !== 'check' && sub !== 'ready') || arg === undefined || rest.length > 0) fail([USAGE]);
      const dailyLimit = patrolAutoSupplyConfig(config).dailyLimit;
      const now = new Date();
      if (sub === 'check') {
        let text: string;
        try {
          text = readFileSync(arg, 'utf8');
        } catch (e) {
          return fail([`候補のファイルが読めません：${(e as Error).message}`, USAGE]);
        }
        const parsed = parseAutoSupplyCandidates(text);
        if (!parsed.ok) return fail(parsed.errors);
        const gh = ctx.gh();
        const autoMode = await readAutoMode(gh, config);
        const self = await readOrFail('自分のログイン（/user）', async () => (await gh.get<{ login: string }>('/user')).login);
        const recent = await readOrFail('自分が作った Issue の一覧', () => recentIssues(gh, self, now));
        const selection = selectAutoSupply({ autoMode, candidates: parsed.candidates, guardrail: config, dailyLimit, createdLast24h: countRecentAutoSupply(recent, self, now) });
        console.log(JSON.stringify({ ...selection, autoModeReason: autoMode.reason }, null, 2));
        return;
      }
      if (!/^\d+$/.test(arg)) fail([USAGE]);
      const n = Number(arg);
      const gh = ctx.gh();
      const autoMode = await readAutoMode(gh, config);
      const self = await readOrFail('自分のログイン（/user）', async () => (await gh.get<{ login: string }>('/user')).login);
      const recent = await readOrFail('自分が作った Issue の一覧', () => recentIssues(gh, self, now));
      const issue = await readOrFail(`Issue #${n}`, async () => toAutoSupplyIssue(await gh.get<IssueRow>(`/issues/${n}`)));
      const { ready, reasons } = autoSupplyReady({ autoMode, issue, recent, self, now, dailyLimit });
      if (ready) await gh.addLabels(n, [LABELS.ready]);
      console.log(JSON.stringify({ issue: n, ready, reasons, added: ready }, null, 2));
    },
  },
];
