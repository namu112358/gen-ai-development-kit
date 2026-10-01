// Issue #437：collect が Epic を「開いた epic のラベルの Issue の一覧 → Epic ごとの子課題（sub-issues をページで全部と、App の epic-split
// の記録）」から読むこと、1つの Epic が読めなくてもほかの Epic は出る（読めない Epic は前回の値と error の注意）こと、子課題が 100 件を
// 超える Epic の Close の数が正しいことを、このファイルの偽の gh で確かめる（App の名義だけ数えることは session-inputs.test.ts に任せる）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { FLEET_STAGES, type FleetStatusRow } from '../lib/fleet.ts';
import type { IssueComment } from '../lib/github.ts';
import { stripAnsi, type PaneEpic, type PaneEpicIssue, type PaneSnapshot } from '../lib/panes.ts';
import { readHqView, renderHqBoard } from '../lib/panes-hq.ts';
import { collectOnce, type CollectDeps, type CollectOptions, type RunResult } from '../scripts/panes.ts';
import { APP, config } from './support/gate-fixtures.ts';

const NOW = Date.parse('2026-10-01T01:00:00.000Z');
const ok = (v: unknown): RunResult => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
const FAIL: RunResult = { status: 1, stdout: '', stderr: 'HTTP 502' };
const iss = (number: number, state = 'OPEN'): PaneEpicIssue => ({ number, title: `t${number}`, state });
const row = (issue: number): FleetStatusRow => ({
  issue, title: `t${issue}`, pr: null, stage: 'plan-ok', stageLabel: FLEET_STAGES['plan-ok'], next: 'implement', selected: true, waitReason: null,
  overlaps: [], sharedOnlyOverlaps: [], note: null, claim: null, prClaim: null,
});
const splitRecord = (children: number[]): IssueComment => ({
  id: 1, body: `${appMark('epic-split')}\n記録\n${renderBlock('agent-app', { version: 1, planCommentId: 1, children })}`, html_url: 'u1',
  created_at: '2026-09-30T00:00:00Z', updated_at: '', author_association: 'NONE', user: { login: APP, type: 'Bot' },
});

interface Page { nodes: PaneEpicIssue[]; next?: string }
interface Fake {
  epics: { number: number; title: string }[] | 'fail';
  subs: Record<number, Page[] | 'fail'>;
  comments?: Record<number, IssueComment[]>;
  aliases?: Record<number, PaneEpicIssue>;
}

/** 偽の gh：issue list・subIssues を含むクエリ・/comments・c<番号>: を含むクエリで見分けて答える */
function fakeDeps(f: Fake, issues: number[], prev: PaneSnapshot | null = null): { deps: CollectDeps; gh: string[][] } {
  const gh: string[][] = [];
  const val = (args: string[], key: string): string | undefined => args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
  const deps: CollectDeps = {
    run(cmd, args) {
      if (cmd !== 'gh') return args[1] === 'fleet-status' ? ok({ version: 1, rows: issues.map(row), selectedCount: issues.length, selected: issues, max: null, mode: null }) : FAIL;
      gh.push(args);
      if (args[0] === 'issue' && args[1] === 'list') return f.epics === 'fail' ? FAIL : ok(f.epics.map((e) => ({ ...e, state: 'OPEN' })));
      const comments = args.find((a) => /\/issues\/\d+\/comments$/.test(a));
      if (comments) return ok([f.comments?.[Number(comments.match(/issues\/(\d+)\//)![1])] ?? []]);
      const query = val(args, 'query') ?? '';
      if (/\bc\d+\s*:/.test(query)) {
        const nums = [...query.matchAll(/\bc(\d+)\s*:/g)].map((m) => Number(m[1]));
        return ok({ data: { repository: Object.fromEntries(nums.map((n) => [`c${n}`, f.aliases?.[n] ?? null])) } });
      }
      if (query.includes('subIssues')) {
        const pages = f.subs[Number(val(args, 'number'))];
        if (!pages || pages === 'fail') return FAIL;
        const after = val(args, 'after');
        const i = after === undefined ? 0 : pages.findIndex((p) => p.next === after) + 1;
        const p = pages[i]!;
        return ok({ data: { repository: { issue: { subIssues: { nodes: p.nodes, pageInfo: { hasNextPage: p.next !== undefined, endCursor: p.next ?? null } } } } } });
      }
      return FAIL;
    },
    exists: () => false,
    readSnapshot: () => prev,
    writeSnapshot: () => {},
    now: () => new Date(NOW),
    env: { PATH: '/bin' },
    root: '/repo',
    home: '/home/u',
    node: 'node-bin',
  };
  return { deps, gh };
}
const opts = (issues: number[]): CollectOptions => ({
  session: 'sess-1', label: 'fleet-a', issues, snapshotPath: '/tmp/agent-harness-panes/sess-1.json', transcriptCwd: '/work', intervalSeconds: 180, config,
});
const queries = (gh: string[][]): string[] => gh.map((a) => a.find((x) => x.startsWith('query=')) ?? '').filter((q) => q !== '');

test('collect：開いた epic のラベルの Issue と子課題（sub-issues と epic-split の記録）から epics・issueEpic を作る', () => {
  const { deps, gh } = fakeDeps({
    epics: [{ number: 281, title: 'E281' }, { number: 290, title: 'E290' }, { number: 300, title: 'E300' }],
    subs: { 281: [{ nodes: [iss(11, 'CLOSED'), iss(12)] }], 290: [{ nodes: [iss(21)] }], 300: [{ nodes: [iss(30)] }] },
    comments: { 281: [splitRecord([11, 12, 13])] },
    aliases: { 13: iss(13) },
  }, [11, 13, 21, 22]);
  const s = collectOnce(deps, opts([11, 13, 21, 22]));
  const list = gh.find((a) => a[0] === 'issue' && a[1] === 'list');
  assert.ok(list, 'gh issue list を呼ぶ');
  for (const [flag, v] of [['--label', 'epic'], ['--state', 'open']]) assert.equal(list[list.indexOf(flag!) + 1], v, flag);
  assert.deepEqual(s.epics, [
    { number: 281, title: 'E281', state: 'OPEN', children: [iss(11, 'CLOSED'), iss(12), iss(13)] },
    { number: 290, title: 'E290', state: 'OPEN', children: [iss(21)] },
  ] satisfies PaneEpic[], 'fleet の Issue を子に持つ Epic だけ。記録にだけある #13 も子課題に入る');
  assert.deepEqual(s.issueEpic, { 11: 281, 13: 281, 21: 290, 22: null });
  assert.ok(queries(gh).every((q) => !/\bparent\b/.test(q)), 'Issue ごとの親は引かない');
  assert.equal(s.error, null);
});

test('collect：1つの Epic が読めなくてもほかの Epic は出る。Epic の一覧が読めなければ前回の値全体', () => {
  const oldA: PaneEpic = { number: 281, title: 'old', state: 'OPEN', children: [iss(11)] };
  const prev: PaneSnapshot = {
    version: 1, at: '2026-10-01T00:57:00.000Z', session: 'sess-1', label: 'fleet-a', intervalSeconds: 180, issues: [11, 21], status: null,
    prs: [], usage: null, history: [], since: {}, error: null, epics: [oldA], issueEpic: { 11: 281, 21: null },
  };
  const f: Fake = { epics: [{ number: 281, title: 'E281' }, { number: 290, title: 'E290' }], subs: { 281: 'fail', 290: [{ nodes: [iss(21, 'CLOSED')] }] } };
  const s = collectOnce(fakeDeps(f, [11, 21], prev).deps, opts([11, 21]));
  assert.deepEqual(s.epics, [oldA, { number: 290, title: 'E290', state: 'OPEN', children: [iss(21, 'CLOSED')] }]);
  assert.deepEqual(s.issueEpic, { 11: 281, 21: 290 });
  assert.match(s.error ?? '', /Epic #281/);
  assert.doesNotMatch(s.error ?? '', /Epic #290/);

  const all = collectOnce(fakeDeps({ ...f, epics: 'fail' }, [11, 21], prev).deps, opts([11, 21]));
  assert.deepEqual(all.epics, [oldA]);
  assert.deepEqual(all.issueEpic, { 11: 281, 21: null });
  assert.match(all.error ?? '', /Epic が読めませんでした/);
});

test('collect：子課題が 100 件を超える Epic をページで全部読み、Close の数を 150 件から数える', () => {
  const nums = Array.from({ length: 150 }, (_, i) => 1001 + i);
  const children = nums.map((n, i) => iss(n, i < 120 ? 'CLOSED' : 'OPEN'));
  const { deps, gh } = fakeDeps({
    epics: [{ number: 281, title: 'E281' }],
    subs: { 281: [{ nodes: children.slice(0, 100), next: 'CUR1' }, { nodes: children.slice(100) }] },
  }, [1001]);
  const s = collectOnce(deps, opts([1001]));
  assert.equal(s.epics?.[0]?.children.length, 150);
  assert.equal(s.epics?.[0]?.children.filter((c) => c.state === 'CLOSED').length, 120);
  const subCalls = gh.filter((a) => (a.find((x) => x.startsWith('query=')) ?? '').includes('subIssues'));
  assert.equal(subCalls.length, 2);
  assert.ok(!subCalls[0]!.some((a) => a.startsWith('after=')), '1回目は after を渡さない');
  assert.ok(subCalls[1]!.includes('after=CUR1'), '2回目に1回目の endCursor を渡す');
  const v = readHqView({ fleets: [{ theme: 'E', epic: 281, session: 'sess-1', startedAt: '2026-10-01T00:50:00.000Z' }] }, () => s, NOW, 10);
  const text = stripAnsi(renderHqBoard(v, 'epic', NOW, 120));
  assert.ok(text.includes('120/150'), text);
});
