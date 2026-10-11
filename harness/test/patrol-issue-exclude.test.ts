// Issue #669：patrol のまとめの Issue（題が patrolIssueTitle）を、fleet・Epic の振り分け・ラベルの監査・重なりの候補・opened の App の処理から除く
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { onIssue } from '../gates/on-issue.ts';
import type { HarnessConfig } from '../lib/config.ts';
import { selectTriageTargets, type TriageIssue } from '../lib/epic-triage.ts';
import { fleetTargets, type FleetTargetItem } from '../lib/fleet.ts';
import { selectOverlapCandidates, type OpenIssue } from '../lib/issue-overlap.ts';
import type { askJev } from '../lib/jev.ts';
import { labelAuditRows, type AuditIssue } from '../lib/label-rules.ts';
import { DEFAULT_PATROL_ISSUE_TITLE, isHarnessIssueTitle, patrolIssueTitle } from '../lib/state.ts';
import { config, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');
const OTHER_TITLE = 'chore: patrol のまとめではない';

// 設定の3つの形：設定の値・キーが無い・空文字（無い・空なら既定の題）
const { patrolIssueTitle: _omit, ...withoutKey } = config;
const CONFIGS: { name: string; cfg: HarnessConfig; title: string }[] = [
  { name: '設定の値', cfg: config, title: patrolIssueTitle(config) },
  { name: 'キーが無い', cfg: withoutKey as HarnessConfig, title: DEFAULT_PATROL_ISSUE_TITLE },
  { name: '空文字', cfg: { ...config, patrolIssueTitle: '' }, title: DEFAULT_PATROL_ISSUE_TITLE },
];

// ---- AC 3：設定と雛形 ----

test('設定：harness.config.json と雛形に patrolIssueTitle があり、既定は「patrol のまとめ」', () => {
  assert.equal(DEFAULT_PATROL_ISSUE_TITLE, 'patrol のまとめ');
  for (const f of ['harness.config.json', 'harness/templates/harness.config.json']) {
    const json = JSON.parse(readFileSync(join(root, f), 'utf8')) as { patrolIssueTitle?: unknown };
    assert.equal(json.patrolIssueTitle, DEFAULT_PATROL_ISSUE_TITLE, f);
  }
  for (const { name, cfg, title } of CONFIGS) {
    assert.equal(patrolIssueTitle(cfg), title, name);
    assert.equal(isHarnessIssueTitle(cfg, title), true, `${name}：まとめの題`);
    assert.equal(isHarnessIssueTitle(cfg, cfg.dashboardIssueTitle), true, `${name}：ダッシュボードの題`);
    assert.equal(isHarnessIssueTitle(cfg, OTHER_TITLE), false, `${name}：ほかの題`);
  }
});

// ---- AC 1：一覧から除く ----

test('fleetTargets：まとめの Issue（作成者 OWNER・agent: なし）は除き、同じ形のほかの題は残す', () => {
  for (const { name, cfg, title } of CONFIGS) {
    const item = (number: number, t: string): FleetTargetItem => ({ number, title: t, labels: [], user: { login: 'me' }, author_association: 'OWNER' });
    assert.deepEqual(fleetTargets([item(1, title), item(2, OTHER_TITLE)], cfg).map((i) => i.number), [2], name);
  }
});

test('selectTriageTargets・selectOverlapCandidates・labelAuditRows：まとめの Issue を除き、同じ形のほかの題は残す', () => {
  for (const { name, cfg, title } of CONFIGS) {
    const excluded = (t: string) => isHarnessIssueTitle(cfg, t);

    const triage = (number: number, t: string): TriageIssue => ({ number, title: t, body: '', labels: [], isPullRequest: false, subIssues: 0 });
    assert.deepEqual(selectTriageTargets([triage(1, title), triage(2, OTHER_TITLE)], [], excluded).map((i) => i.number), [2], `${name}：Epic の振り分け`);

    // 下書きの題をまとめの題と同じ語にして、重なりが0で落ちないようにする
    const open = (number: number, t: string): OpenIssue => ({ number, title: t, body: '', labels: [], isPullRequest: false });
    const draft = { title: `chore: ${title} ${OTHER_TITLE}`, body: null };
    assert.deepEqual(selectOverlapCandidates(draft, [open(1, title), open(2, OTHER_TITLE)], excluded, 10).map((i) => i.number), [2], `${name}：重なりの候補`);

    const audit = (number: number, t: string): AuditIssue => ({ number, title: t, html_url: `https://x/${number}`, labels: [{ name: 'agent:ready' }] });
    assert.deepEqual(labelAuditRows(cfg, 'o/r', [audit(1, title), audit(2, OTHER_TITLE)], []).map((r) => r.number), [2], `${name}：ラベルの監査`);
  }
});

// ---- AC 2：opened で App は何もしない ----

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
const N = 50;
// 題の書式（parseTitle）に合うまとめの題。既定の「patrol のまとめ」は書式に合わず今でも Jev に問わないので、比べにならない
const PATROL = 'chore: patrol のまとめ';
const OTHER = 'chore: ほかの題';

/** 偽の GitHub。Issue の読み直しは title で返し、ラベルの付与・コメントを受ける */
function openFake(title: string): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\/(\d+)$/, (m) => ({ number: Number(m[1]), title, body: FORM_BODY, state: 'open', html_url: 'i', user: { login: 'me' }, labels: [] }))
    .on('GET', /\/issues\/\d+\/comments/, () => [])
    .on('GET', /\/issues\/\d+\/events/, () => [])
    .on('POST', /\/issues\/\d+\/labels$/, () => [])
    .on('DELETE', /\/labels\//, () => null)
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }));
}

/** 偽の Jev。問われた Issue のタイトルを記録する */
function fakeJev() {
  const asked: string[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(String((request.state as { title: string }).title));
    return {
      status: 'ok', model: 'jev-test', answers: {
        type: { type: 'choice', probabilities: { feature: 0.9 } },
        area: { type: 'choice', probabilities: { docs: 0.9 } },
        priority: { type: 'choice', probabilities: { high: 0.9 } },
        ac_verifiable: { type: 'noul', noul: 0.9 },
        requirements_clear: { type: 'noul', noul: 0.9 },
      },
    };
  };
  return { asked, fn };
}

test('opened：まとめの Issue にはラベルを付けず Jev にも問わない。同じ形のほかの題ではラベルを付けて Jev に問う', async () => {
  const cfg: HarnessConfig = { ...config, patrolIssueTitle: PATROL, classification: { ...config.classification, issueTriage: 'label' } };
  const run = async (title: string) => {
    const jev = fakeJev();
    const fake = openFake(title);
    const event = { action: 'opened', sender: { login: 'me' }, issue: { number: N, title, body: FORM_BODY, state: 'open', labels: [] } };
    await onIssue(ctxFor(fake, 'issues', event, { config: cfg, secrets: { jevApiKey: 'jev-key' }, askJev: jev.fn }));
    return { asked: jev.asked, writes: fake.writes() };
  };

  const other = await run(OTHER);
  assert.ok(other.writes.length > 0, 'ほかの題ではラベルを付ける（比べ）');
  assert.deepEqual(other.asked, [OTHER], 'ほかの題では Jev に問う（比べ）');

  const patrol = await run(PATROL);
  assert.deepEqual(patrol.writes, [], 'まとめの Issue には書き込まない');
  assert.deepEqual(patrol.asked, [], 'まとめの Issue は Jev に問わない');
});
