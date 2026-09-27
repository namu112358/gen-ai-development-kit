import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onSchedule } from '../gates/stale.ts';
import { labelAuditRows, renderAuditLines } from '../lib/label-rules.ts';
import { APP, config, ctxFor, FakeGitHub, pr } from './support/gate-fixtures.ts';

const SECTION = 'ラベルが足りない Issue・PR';

test('renderAuditLines は問題のあるものだけを、番号・タイトル・不足・違反の1行にする', () => {
  const lines = renderAuditLines([
    { number: 3, title: 'feat: a', html_url: 'https://x/3', missing: ['type:feat', 'area:*'], violations: [] },
    { number: 4, title: 'fix: b', html_url: 'https://x/4', missing: [], violations: [] },
    { number: 5, title: 'docs: c', html_url: 'https://x/5', missing: [], violations: ['優先度が2つ以上'] },
    { number: 6, title: 'feat: d', html_url: 'https://x/6', missing: ['size:*'], violations: ['type がタイトルと食い違う'] },
  ]);
  assert.equal(lines.length, 3);
  assert.ok(lines[0]!.includes('#3') && lines[0]!.includes('feat: a') && lines[0]!.includes('type:feat') && lines[0]!.includes('area:*'));
  assert.ok(lines[1]!.includes('#5') && lines[1]!.includes('優先度が2つ以上'));
  assert.ok(lines[2]!.includes('#6') && lines[2]!.includes('size:*') && lines[2]!.includes('type がタイトルと食い違う'));
  assert.ok(!lines.some((l) => l.includes('#4')));
});

const labels = (...names: string[]) => names.map((name) => ({ name }));
const issueItem = (number: number, title: string, names: string[], patch: Record<string, unknown> = {}) => ({
  number, title, html_url: `https://x/${number}`, updated_at: '2026-09-27T00:00:00Z', labels: labels(...names), user: { login: 'me' }, ...patch,
});

const ISSUES = [
  // 対象：agent:* の Issue（不足あり）
  issueItem(10, 'feat: agent issue', ['agent:ready']),
  // 対象：agent:* の Issue（揃っている）
  issueItem(11, 'fix: ok issue', ['agent:ready', 'type:fix', 'area:harness', 'priority:medium']),
  // 対象：epic（子あり、type 無しは不足としない。priority が無い）
  issueItem(12, 'feat: epic', ['epic', 'area:harness'], { sub_issues_summary: { total: 2, completed: 0, percent_completed: 0 } }),
  // 対象外：agent:* も epic も無い Issue
  issueItem(13, 'untriaged', []),
  // 対象外：/issues に混ざった PR（PR は Agent PR の側で見る）
  issueItem(20, 'Some PR', ['agent:hold'], { pull_request: {} }),
  // 対象外：ダッシュボード自身
  issueItem(1, config.dashboardIssueTitle, ['agent:auto-merge-stopped'], { user: { login: APP } }),
];

const PRS = [
  pr({ number: 20, title: 'feat: agent pr', labels: labels('area:harness'), head: { ref: 'claude/issue-10', sha: 'a'.repeat(40), repo: { full_name: 'o/r' } } }),
  pr({ number: 21, title: 'chore: human pr', labels: [], head: { ref: 'feature/x', sha: 'c'.repeat(40), repo: { full_name: 'o/r' } } }),
  pr({ number: 22, title: 'chore(deps): bump', labels: [], user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/npm/x', sha: 'd'.repeat(40), repo: { full_name: 'o/r' } } }),
];

test('labelAuditRows は agent:* か epic の Issue と Agent PR だけを検査する', () => {
  const rows = labelAuditRows(config, 'o/r', ISSUES, PRS);
  assert.deepEqual(rows.map((r) => r.number).sort((a, b) => a - b), [10, 11, 12, 20]);
  assert.deepEqual(rows.find((r) => r.number === 12)!.missing, ['priority:*']);
  assert.deepEqual(rows.find((r) => r.number === 20)!.missing, ['type:feat', 'size:*'], '番号 20 は PR の規則で見る');
});

function scheduleFake(existingBody: string): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: true }))
    .on('GET', /\/issues\?state=open&creator=/, () => [ISSUES.at(-1)])
    .on('GET', /\/issues\?state=open&per_page/, () => ISSUES)
    .on('GET', /\/pulls\?state=open/, () => PRS)
    .on('GET', /\/pulls\/(\d+)$/, (m) => ({ ...PRS.find((p) => p.number === Number(m[1]))!, mergeable_state: 'clean' }))
    .on('GET', /\/issues\/1$/, () => ({ body: existingBody }))
    .on('PATCH', /\/issues\/1$/, () => ({}));
}

test('ダッシュボードに「ラベルが足りない Issue・PR」の節が出て、既存の節と queue の節が残る', async () => {
  const queue = '<!-- agent-harness:queue:start -->\nqueue の中身\n<!-- agent-harness:queue:end -->';
  const fake = scheduleFake(`old\n\n${queue}`);
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date('2026-09-27T01:00:00Z'));
  const patch = fake.calls.find((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1'));
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  const body = String(patch.body.body);
  assert.ok(body.includes(`### ${SECTION}（3）`), body);
  const section = body.slice(body.indexOf(`### ${SECTION}`), body.indexOf('失敗した Actions'));
  assert.ok(section.includes('#10') && section.includes('type:feat') && section.includes('priority:*'));
  assert.ok(section.includes('#12') && !section.includes('type:*'), 'Epic に type を求めない');
  assert.ok(section.includes('#20') && section.includes('size:*'));
  for (const n of ['#11', '#13', '#21', '#22', '#1]']) assert.ok(!section.includes(n), `${n} は出さない`);
  for (const s of ['人の対応待ち', 'コンフリクトしている Agent PR', '停滞している Agent PR', '停滞している Issue']) assert.ok(body.includes(s), `${s} の節が消えた`);
  assert.ok(body.endsWith(queue), 'queue の節が消えた');
});

test('問題が無ければ節は「なし」', async () => {
  const fake = new FakeGitHub()
    .on('GET', /\/repos\/o\/r$/, () => ({ allow_auto_merge: true }))
    .on('GET', /\/issues\?state=open&creator=/, () => [ISSUES.at(-1)])
    .on('GET', /\/issues\?state=open&per_page/, () => [ISSUES[1], ISSUES.at(-1)])
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', /\/issues\/1$/, () => ({ body: '' }))
    .on('PATCH', /\/issues\/1$/, () => ({}));
  await onSchedule(ctxFor(fake, 'schedule', {}), new Date('2026-09-27T01:00:00Z'));
  const body = String(fake.calls.find((c) => c.method === 'PATCH')!.body.body);
  assert.ok(body.includes(`### ${SECTION}（0）\n\nなし`), body);
});
