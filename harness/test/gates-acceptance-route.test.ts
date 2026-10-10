// 判定の受け付けのコメントの表の経路が、委任承認・auto mode・bypass で乗る実際の経路と食い違わないこと（Issue #468）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { appMark, renderBlock } from '../lib/blocks.ts';
import { bypassMergeConfig, delegateConfig, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { onComment } from '../gates/on-comment.ts';
import { APP, acceptanceFake, config as base, ctxFor, pr, verdict, verdictEvent, type FakeGitHub } from './support/gate-fixtures.ts';
import { postedBodies } from './support/stack-fixtures.ts';

/** 判定の受け付けで Risk の Jev（callJev）が本物の API を呼ばないよう、jev.mode は off にする（auto mode の危険の問いは jev.mode と独立） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };

const AUTO = autoModeConfig(config).label;
const BYPASS = bypassMergeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
/** ガードレールにも delegateMergeExclude にも当たる（委任でも乗らない） */
const CONFIG_FILE = 'harness.config.json';
/** ガードレールに当たるが delegateMergeExclude には当たらない（委任で乗る） */
const GUARDED = 'harness/lib/epic.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const ev = (event: 'labeled' | 'unlabeled', name: string, at: string) => ({ event, created_at: at, actor: { login: 'me' }, label: { name } });
const critical = () => verdict({ risk: { ...verdict().risk, level: 'critical' } });

/** 計画ゲートを通った記録（files 指定） */
const planGate = (files: string[]) => ({
  id: 90, created_at: '2026-09-26T00:00:00Z', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nok\n${renderBlock('agent-app', { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { files } })}`,
});

/** 判定の受け付け（onComment）用。既定は、変更ファイルと計画の files がどちらも harness.config.json（範囲内・委任しないパス） */
function verdictFake(o: { dashboardLabels: string[]; events?: unknown[]; files?: string[] }): FakeGitHub {
  const files = o.files ?? [CONFIG_FILE];
  return acceptanceFake({ pr: pr(), dashboardLabels: o.dashboardLabels, dashboardEvents: o.events ?? [], prComments: [] })
    .on('GET', /\/issues\/3\/comments/, () => [planGate(files)])
    .on('GET', /\/pulls\/5\/files/, () => files.map((filename) => ({ filename, additions: 1, deletions: 1 })))
    .on('GET', /\/issues\/5\/events/, () => []);
}

/** 偽の Jev。危険の問い（danger）にだけ answer で答える */
function fakeJev(answer: number): typeof askJev {
  return async (_key, request) => {
    if (!Object.keys(request.questions).includes('danger')) return { status: 'error', detail: '危険の問いではない' };
    return { status: 'ok', model: 'jev-test', answers: { danger: { type: 'noul', noul: answer } } as any };
  };
}

/** critical の判定コメントを受け付ける（Jev は安全と答え、鍵がある） */
async function accept(fake: FakeGitHub): Promise<void> {
  const extra = { config, secrets: { jevApiKey: 'jev-key' }, askJev: fakeJev(0.01) };
  await onComment(ctxFor(fake, 'issue_comment', verdictEvent(renderBlock('agent-verdict', critical())), extra));
}

const acceptanceBody = (fake: FakeGitHub): string => postedBodies(fake, 'acceptance')[0]!;
const routeLine = (fake: FakeGitHub) => acceptanceBody(fake).split('\n').find((l) => l.startsWith('| 経路 |'));

test('受け付けの経路：bypass が有効で harness.config.json に触れる critical の PR は、bypass で乗る自動 Merge の経路と書き、理由の見出しも bypass で飛ばすと書く', async () => {
  const fake = verdictFake({ dashboardLabels: [BYPASS], events: [ev('labeled', BYPASS, minutesAgo(300))] });
  await accept(fake);
  assert.ok(fake.writes().includes('enablePullRequestAutoMerge'), fake.writes().join('\n'));
  assert.equal(routeLine(fake), '| 経路 | 自動 Merge（bypass モードで auto-merge を設定） |');
  const body = acceptanceBody(fake);
  assert.ok(body.includes('自動 Merge の対象外の理由（bypass モードで飛ばして自動経路に乗せます）:'), body);
  assert.ok(!body.includes('自動 Merge しない理由:'), body);
});

test('受け付けの経路：委任承認（計画＋Merge）が有効でガードレールだけに触れる critical の PR は、委任で乗る自動 Merge の経路と書く', async () => {
  const fake = verdictFake({ dashboardLabels: [DELEGATE], events: [ev('labeled', DELEGATE, minutesAgo(10))], files: [GUARDED] });
  await accept(fake);
  assert.ok(fake.writes().includes('enablePullRequestAutoMerge'), fake.writes().join('\n'));
  assert.equal(routeLine(fake), '| 経路 | 自動 Merge（委任承認（計画＋Merge）で auto-merge を設定） |');
});

test('受け付けの経路：auto mode が有効で Jev が安全と答えた critical の PR は、auto mode で乗る自動 Merge の経路と書く', async () => {
  const fake = verdictFake({ dashboardLabels: [AUTO], events: [ev('labeled', AUTO, minutesAgo(300))] });
  await accept(fake);
  assert.ok(fake.writes().includes('enablePullRequestAutoMerge'), fake.writes().join('\n'));
  assert.equal(routeLine(fake), '| 経路 | 自動 Merge（auto mode で auto-merge を設定） |');
});

test('受け付けの経路：bypass のラベルを外した後の critical の PR は、今までどおり Human Merge と書く', async () => {
  const fake = verdictFake({ dashboardLabels: [], events: [ev('labeled', BYPASS, minutesAgo(300)), ev('unlabeled', BYPASS, minutesAgo(1))] });
  await accept(fake);
  assert.ok(!fake.writes().includes('enablePullRequestAutoMerge'), fake.writes().join('\n'));
  assert.equal(routeLine(fake), '| 経路 | Human Merge（人のレビュー待ち） |');
  assert.ok(acceptanceBody(fake).includes('自動 Merge しない理由:'), acceptanceBody(fake));
});
