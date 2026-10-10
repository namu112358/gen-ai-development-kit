// Issue #550：App に判定を差し戻された（最新の判定の後の App の返事が kind=verdict-rejected）PR を、
// prFacts が verdictRejected として数え、fleet-status の次にやることに「判定のやり直し」として出す。衝突・追従の sync が先なら出さない
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { loadConfig } from '../lib/config.ts';
import { prFacts } from '../lib/facts.ts';
import { fleetStatus, fleetStatusData, renderFleetStatus, selectFleet, type FleetFacts, type FleetIssue, type FleetPr } from '../lib/fleet.ts';
import { GitHub, type IssueComment } from '../lib/github.ts';
import type { IssueFacts, PrFacts } from '../lib/queue.ts';
import { APP, DIFF, FakeGitHub, config, pr, verdict } from './support/gate-fixtures.ts';

// ---- prFacts の verdictRejected ----

const CURRENT = 'c'.repeat(40);
const current = () => pr({ head: { ref: 'claude/issue-3-x', sha: CURRENT, repo: { full_name: 'o/r' } } });

let nextId = 1;
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();
function verdictComment(createdAt: string): IssueComment {
  const id = nextId++;
  return {
    id, html_url: `u${id}`, created_at: createdAt, updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' },
    body: `${CLAUDE_MARK}\n## 判定\n\n${renderBlock('agent-verdict', verdict({ headSha: CURRENT }))}`,
  };
}
/** kind の目印のコメント。by が APP なら App の返事、それ以外なら App の名義でない目印 */
function markComment(kind: 'acceptance' | 'verdict-rejected', createdAt: string, by: string = APP): IssueComment {
  const id = nextId++;
  return {
    id, html_url: `u${id}`, created_at: createdAt, updated_at: '', author_association: by === APP ? 'NONE' : 'OWNER',
    user: { login: by, type: by === APP ? 'Bot' : 'User' },
    body: `${appMark(kind)}\n記録\n${renderBlock('agent-app', { version: 1, patchId: 'x' })}`,
  };
}

function factsFake(comments: IssueComment[]): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/pulls\/5$/, () => current())
    .on('GET', /\/issues\/5\/comments/, () => comments)
    .on('GET', /\/pulls\/5\/reviews/, () => [])
    .on('GET', /\/commits\/\w+$/, () => ({ commit: { committer: { date: '2026-09-27T00:00:00Z' } } }))
    .on('GET', /\/commits\/\w+\/check-runs/, () => ({ check_runs: [] }))
    .on('GET', /\/compare\/main\.\.\.(\w+)$/, () => DIFF)
    .on('POST', /\/graphql/, (_m, body) => {
      if (String(body.query).includes('closingIssuesReferences')) {
        return { data: { repository: { pullRequest: { closingIssuesReferences: { nodes: [{ number: 3, repository: { nameWithOwner: 'o/r' } }] } } } } };
      }
      return { data: {} };
    });
}
const run = (comments: IssueComment[]) => prFacts(new GitHub(factsFake(comments), 'o/r'), config, current() as never, new Map(), new Map());

test('prFacts：最新の判定の後の App の返事が verdict-rejected なら verdictRejected は true、それ以外は false', async () => {
  const cases: { name: string; comments: () => IssueComment[]; want: boolean }[] = [
    { name: '判定の後に App の verdict-rejected', comments: () => [verdictComment(at(-120_000)), markComment('verdict-rejected', at(-60_000))], want: true },
    { name: '判定の後に App の acceptance', comments: () => [verdictComment(at(-120_000)), markComment('acceptance', at(-60_000))], want: false },
    { name: '判定の後に App の返事がまだ無い', comments: () => [verdictComment(at(-60_000))], want: false },
    { name: '判定が無い（App の verdict-rejected だけ）', comments: () => [markComment('verdict-rejected', at(-60_000))], want: false },
    { name: 'App 以外が書いた kind=verdict-rejected の目印', comments: () => [verdictComment(at(-120_000)), markComment('verdict-rejected', at(-60_000), 'me')], want: false },
    {
      name: '差し戻しの後に新しい判定を投稿した（返事はまだ）',
      comments: () => [verdictComment(at(-180_000)), markComment('verdict-rejected', at(-120_000)), verdictComment(at(-60_000))],
      want: false,
    },
  ];
  for (const c of cases) {
    const f = await run(c.comments());
    assert.equal(f.verdictRejected === true, c.want, c.name);
  }
});

// ---- fleet-status の次にやること ----

const fleetConfig = loadConfig();
const issueFacts = (n: number): IssueFacts => ({
  number: n, title: `t${n}`, labels: ['agent:ready', 'agent:plan-ok'], readyAt: '2026-09-26T00:01:00Z', claim: null, openBlockers: [],
  gate: { pass: true, planCommentId: 5, at: '2026-09-26T01:01:00Z' }, latestPlanAt: '2026-09-26T01:00:00Z', planOkByApp: true, openPr: null,
});
const prFactsOf = (n: number, issue: number, patch: Partial<PrFacts> = {}): PrFacts => ({
  number: n, agent: true, conflicted: false, claim: null, issueLabels: [], issue, readyAt: null, labels: [], headSha: 'h', headPushedAt: '2026-09-26T01:00:00Z',
  acceptance: null, verdictAwaitingGate: false, humanFeedbackSincePush: 0, ...patch,
});
const openPr = (n: number, issue: number, patch: Partial<PrFacts> = {}): FleetPr =>
  ({ number: n, merged: false, draft: true, autoMerge: false, humanReview: false, behindMain: false, facts: prFactsOf(n, issue, patch) });
const fi = (facts: IssueFacts, prs: FleetPr[]): FleetIssue => ({ facts, closed: false, planFiles: null, prs });

/** Issue #1 と PR #10 の行を、行の値・表の「次にやること」の列・--json の行で返す */
function view(patch: Partial<PrFacts>) {
  const facts: FleetFacts = { issues: [fi(issueFacts(1), [openPr(10, 1, patch)])], prConflicts: [] };
  const rows = fleetStatus(facts);
  const sel = selectFleet(fleetConfig, facts, rows, null, null);
  const table = renderFleetStatus(rows, sel, null);
  const line = table.split('\n').find((l) => l.startsWith('| #1 '));
  assert.ok(line, `表に #1 の行がある：\n${table}`);
  const cells = line.split('|').map((c) => c.trim());
  const json = fleetStatusData(facts, rows, sel, null, null).rows.find((r) => r.issue === 1)!;
  return { row: rows.find((r) => r.issue === 1)!, nextCell: cells[4]!, noteCell: cells.at(-2)!, json };
}

test('fleet-status：差し戻された PR は段階 judge・次にやること judge のまま、表の次にやることとメモに「判定のやり直し」が出る', () => {
  const { row, nextCell, noteCell, json } = view({ verdictRejected: true } as Partial<PrFacts>);
  assert.equal(row.stage, 'judge');
  assert.equal(row.next, 'judge');
  assert.equal(row.pr, 10);
  assert.ok(nextCell.startsWith('judge'), `次にやることの列は judge から始まる：${nextCell}`);
  assert.ok(nextCell.includes('判定のやり直し'), `次にやることの列に「判定のやり直し」：${nextCell}`);
  assert.ok((row.note ?? '').includes('判定のやり直し'), `メモに「判定のやり直し」：${row.note}`);
  assert.ok(noteCell.includes('判定のやり直し'), `表のメモの列に「判定のやり直し」：${noteCell}`);
  assert.equal(json.next, 'judge', '--json の next は judge のまま');
});

test('fleet-status：差し戻された PR でも衝突していれば next は sync で、「判定のやり直し」は出さない（メモは main と衝突）', () => {
  const { row, nextCell, json } = view({ verdictRejected: true, conflicted: true } as Partial<PrFacts>);
  assert.equal(row.next, 'sync');
  assert.ok(nextCell.startsWith('sync'), `次にやることの列は sync：${nextCell}`);
  assert.ok(!nextCell.includes('判定のやり直し'), `次にやることの列に「判定のやり直し」を出さない：${nextCell}`);
  assert.ok(!(row.note ?? '').includes('判定のやり直し'), `メモに「判定のやり直し」を出さない：${row.note}`);
  assert.ok((row.note ?? '').includes('main と衝突'), `メモは main と衝突：${row.note}`);
  assert.equal(json.next, 'sync');
});

test('fleet-status：差し戻されていない判定前の PR は今までどおり judge だけ（メモなし）', () => {
  const { row, nextCell } = view({});
  assert.equal(row.stage, 'judge');
  assert.equal(row.next, 'judge');
  assert.equal(nextCell, 'judge');
  assert.equal(row.note, null);
});
