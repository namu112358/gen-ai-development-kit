// Issue #478：改善の候補の節の目印が壊れていても本文を消さないこと、publishQueue が queue と改善の候補の2つの節を1回の PATCH で書くこと
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMPROVE_END, IMPROVE_START, publishQueue, QUEUE_END, QUEUE_START, renderImproveSection, replaceImproveSection } from '../gates/publish-queue.ts';
import type { IssueComment } from '../lib/github.ts';
import { renderIncidentComment } from '../lib/incident.ts';
import { APP, config, ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

const DASHBOARD = 9;
const HUMAN = '人が書いた本文\n消してはいけない';
const SECTION = renderImproveSection([]);

test('replaceImproveSection：目印が壊れた本文はそのまま返す', () => {
  const cases: [string, string][] = [
    ['開始だけ', `前\n\n${IMPROVE_START}\n${HUMAN}`],
    ['終わりだけ', `前\n${HUMAN}\n${IMPROVE_END}\n後`],
    ['開始が2つ', `${IMPROVE_START}\n古い\n${IMPROVE_START}\n${HUMAN}\n${IMPROVE_END}`],
    ['終わりが前', `${IMPROVE_END}\n${HUMAN}\n${IMPROVE_START}\n後`],
  ];
  for (const [name, body] of cases) assert.equal(replaceImproveSection(body, SECTION), body, name);
  const startOnly = cases[0]![1];
  assert.equal(replaceImproveSection(replaceImproveSection(startOnly, SECTION), SECTION), startOnly, '開始だけの本文に2回適用しても変わらない');
});

function comment(id: number, body: string): IssueComment {
  const at = new Date().toISOString();
  return { id, body, html_url: `https://github.com/o/r/issues/${DASHBOARD}#issuecomment-${id}`, created_at: at, updated_at: at, author_association: 'OWNER', user: { login: 'me', type: 'User' } };
}

function dashboardFake(existingBody: string): FakeGitHub {
  const incident = renderIncidentComment('s-1', [{ id: 1, at: new Date().toISOString(), kind: 'deny', what: '偽の起きたこと', source: 'hook' }]);
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&creator=/, () => [{ number: DASHBOARD, title: config.dashboardIssueTitle, labels: [], user: { login: APP } }])
    .on('GET', /\/issues\?state=open&labels=/, () => [])
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', new RegExp(`/issues/${DASHBOARD}$`), () => ({ body: existingBody, comments: 1 }))
    .on('GET', new RegExp(`/issues/${DASHBOARD}/comments\\?per_page=100&page=1`), () => [comment(1, incident)])
    .on('PATCH', new RegExp(`/issues/${DASHBOARD}$`), () => ({}));
}

const patchesOf = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith(`/issues/${DASHBOARD}`));

test('publishQueue：queue と改善の候補の2つの節を1回の PATCH で書く', async () => {
  const fake = dashboardFake('ダッシュボード');
  await publishQueue(ctxFor(fake, 'schedule', {}));
  const patches = patchesOf(fake);
  assert.equal(patches.length, 1);
  const body = String(patches[0]!.body.body);
  const queue = body.slice(body.indexOf(QUEUE_START), body.indexOf(QUEUE_END));
  assert.ok(body.includes(QUEUE_START) && queue.includes('なし'), body);
  const improve = body.slice(body.indexOf(IMPROVE_START), body.indexOf(IMPROVE_END));
  assert.ok(body.includes(IMPROVE_START) && improve.includes('偽の起きたこと'), body);
});

test('publishQueue：改善の候補の開始の目印だけが残った本文でも、人の本文を消さず queue の節は新しくする', async () => {
  const oldQueue = `${QUEUE_START}\n古い queue\n${QUEUE_END}`;
  const fake = dashboardFake(`ダッシュボード\n\n${oldQueue}\n\n${IMPROVE_START}\n${HUMAN}`);
  const logs: string[] = [];
  await publishQueue(ctxFor(fake, 'schedule', {}, { log: (m: string) => logs.push(m) }));
  const patches = patchesOf(fake);
  assert.equal(patches.length, 1);
  const body = String(patches[0]!.body.body);
  assert.ok(body.includes(HUMAN) && body.includes(IMPROVE_START), body);
  assert.ok(!body.includes('古い queue') && body.slice(body.indexOf(QUEUE_START), body.indexOf(QUEUE_END)).includes('なし'), body);
  assert.ok(logs.some((l) => l.includes('目印')), logs.join('\n'));
});
