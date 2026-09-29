// 計画ゲートで止まった計画でも、files が1つの領域に収まれば App が area:* を付けるかのテスト（#161）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, extractBlock, renderBlock } from '../lib/blocks.ts';
import type { SplitChild } from '../lib/epic.ts';
import type { TimelineEvent } from '../lib/state.ts';
import { labelApply, singleAreaLabel } from '../gates/label-apply.ts';
import { onComment } from '../gates/on-comment.ts';
import { acceptanceFake, APP, config, CRITIQUE, critiqueClaim, ctxFor, FakeGitHub, planGateComment, pr } from './support/gate-fixtures.ts';

// --- singleAreaLabel（純粋な関数） ---

test('singleAreaLabel：すべてのファイルが同じ1つの領域に収まればそのラベル', () => {
  assert.equal(singleAreaLabel(config, ['docs/a.md']), 'area:docs');
  assert.equal(singleAreaLabel(config, ['docs/a.md', 'docs/b/c.md', 'README.md']), 'area:docs');
  assert.equal(singleAreaLabel(config, ['harness/lib/x.ts', '.github/workflows/gate.yml']), 'area:harness');
});

test('singleAreaLabel：2つの領域・どこにも当たらないファイル・空なら null', () => {
  assert.equal(singleAreaLabel(config, ['docs/a.md', 'harness/lib/x.ts']), null, 'ファイルごとに違う領域');
  assert.equal(singleAreaLabel(config, ['docs/a.md', 'src/a.ts']), null, 'どの領域にも当たらないファイルがある');
  assert.equal(singleAreaLabel(config, ['src/a.ts']), null);
  assert.equal(singleAreaLabel(config, []), null);
});

test('singleAreaLabel：1つのファイルが2つの領域に当たれば null', () => {
  const overlap = { ...config, classification: { ...config.classification, areas: { docs: ['docs/**'], guide: ['docs/guide/**'] } } };
  assert.equal(singleAreaLabel(overlap, ['docs/guide/a.md']), null);
  assert.equal(singleAreaLabel(overlap, ['docs/a.md']), 'area:docs');
});

// --- 計画ゲートの停止（イベント） ---

const split: SplitChild[] = [
  { title: 'docs: 一つ目', goal: 'g1', requirements: ['r1'], acceptanceCriteria: ['a1'], files: ['docs/a.md'], dependsOn: [] },
  { title: 'docs: 二つ目', goal: 'g2', requirements: ['r2'], acceptanceCriteria: ['a2'], files: ['docs/guide/**'], dependsOn: [0] },
];
/** 未解決の質問があるので計画ゲートで止まる計画 */
const stopped = { version: 1, issue: 3, risk: 'low', needsHuman: false, needsHumanReasons: [], acChangeProposed: false, openQuestions: ['?'], files: ['docs/a.md'], critique: CRITIQUE };
const planEvent = (body: string, names: string[] = ['agent:ready']) => ({
  action: 'created',
  issue: { number: 3, labels: names.map((name) => ({ name })), state: 'open' },
  comment: { id: 80, body, html_url: 'p', author_association: 'OWNER', created_at: '', updated_at: '', user: { login: 'me', type: 'User' } },
});
const comments = () => [critiqueClaim(), planGateComment];
const planGatePost = (fake: FakeGitHub) => fake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/issues/3/comments')).map((c) => String(c.body.body)).find((b) => b.includes('kind=plan-gate'))!;
const labelAdds = (fake: FakeGitHub) => fake.writes().filter((w) => w.startsWith('label+'));

test('計画ゲートの停止：files が1つの領域に収まれば、plan-gate のコメントの後に area:* を付け、コメントに書く', async () => {
  const fake = acceptanceFake({ pr: pr(), issueComments: comments() });
  await onComment(ctxFor(fake, 'issue_comment', planEvent(renderBlock('agent-plan', stopped))));
  assert.deepEqual(fake.writes(), ['label-agent:plan-ok', 'label+agent:plan-review', 'comment:plan-gate', 'label+area:docs', 'check:agent/plan-link=success']);
  const body = planGatePost(fake);
  assert.match(body, /計画ゲートで停止しました/);
  assert.match(body, /area:docs/, '付けたラベルをコメントに書く');
  // 記録の JSON は変えない（area のための項目を足さない）
  const block = extractBlock(body, 'agent-app');
  assert.ok(block.found && block.ok);
  assert.deepEqual(Object.keys(block.value as object).sort(), ['pass', 'plan', 'planBodySha256', 'planCommentId', 'planReviewOrigin', 'reasons', 'version']);
});

test('計画ゲートの停止：files が1つの領域に収まらなければ付けず、コメントにも書かない', async () => {
  for (const files of [['docs/a.md', 'harness/lib/x.ts'], ['docs/a.md', 'src/a.ts'], ['src/a.ts']]) {
    const fake = acceptanceFake({ pr: pr(), issueComments: comments() });
    await onComment(ctxFor(fake, 'issue_comment', planEvent(renderBlock('agent-plan', { ...stopped, files }))));
    assert.deepEqual(labelAdds(fake), ['label+agent:plan-review'], files.join(','));
    assert.doesNotMatch(planGatePost(fake), /`area:/, files.join(','));
  }
});

test('計画ゲートの停止：split の計画には area:* を付けない', async () => {
  const fake = acceptanceFake({ pr: pr(), issueComments: comments() });
  await onComment(ctxFor(fake, 'issue_comment', planEvent(renderBlock('agent-plan', { ...stopped, split }))));
  assert.ok(fake.writes().includes('comment:plan-gate'));
  assert.deepEqual(labelAdds(fake), ['label+agent:plan-review']);
});

test('計画ゲートの停止：Issue に area:* が既にあれば付けない', async () => {
  for (const area of ['area:docs', 'area:harness']) {
    const fake = acceptanceFake({ pr: pr(), issueComments: comments() });
    await onComment(ctxFor(fake, 'issue_comment', planEvent(renderBlock('agent-plan', stopped), ['agent:ready', area])));
    assert.deepEqual(labelAdds(fake), ['label+agent:plan-review'], area);
    assert.doesNotMatch(planGatePost(fake), /を付けました/, area);
  }
});

test('計画ゲートの停止：構造化出力を読めない計画には area:* を付けない', async () => {
  const fake = acceptanceFake({ pr: pr(), issueComments: comments() });
  await onComment(ctxFor(fake, 'issue_comment', planEvent(renderBlock('agent-plan', { version: 1, issue: 3, files: ['docs/a.md'] }))));
  assert.ok(fake.writes().includes('label+agent:blocked'));
  assert.ok(!labelAdds(fake).some((w) => w.includes('area:')), fake.writes().join(' '));
});

// --- 定期実行 ---

const FORM_BODY = ['Goal', 'Requirements', 'Acceptance Criteria'].map((h) => `### ${h}\n\nx`).join('\n\n');
const issue = (number: number, title: string, names: string[]) => ({
  number, title, body: FORM_BODY, html_url: `https://x/${number}`, updated_at: '2026-09-27T00:00:00Z', labels: names.map((name) => ({ name })), user: { login: 'me' },
});
const gateRecord = (id: number, value: unknown) => ({
  id, created_at: '', updated_at: '', html_url: 'u', author_association: 'NONE', user: { login: APP, type: 'Bot' },
  body: `${appMark('plan-gate')}\nx\n${renderBlock('agent-app', value)}`,
});
const stoppedRecord = (plan: Record<string, unknown>) => ({ version: 1, planCommentId: 80, pass: false, reasons: ['未解決の質問が 1 件あります'], planReviewOrigin: 'gate', plan: { ...stopped, ...plan } });

function scheduleFake(issues: ReturnType<typeof issue>[], comments: Record<number, unknown[]>, events: Record<number, TimelineEvent[]> = {}): FakeGitHub {
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&per_page/, () => issues)
    .on('GET', /\/pulls\?state=open/, () => [])
    .on('GET', /\/pulls\?state=closed/, () => [])
    .on('GET', /\/issues\/(\d+)\/events/, (m) => events[Number(m[1])] ?? [])
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => comments[Number(m[1])] ?? [])
    .on('POST', /\/issues\/(\d+)\/labels$/, () => [])
    .on('DELETE', /\/labels\//, () => null)
    .on('POST', /\/issues\/\d+\/comments$/, () => ({ id: 1, html_url: 'u' }));
}

/** 番号つきの書き込み（`#60 label+area:docs` の形） */
function numbered(fake: FakeGitHub): string[] {
  const names = fake.writes();
  return fake.calls.filter((c) => c.method !== 'GET').map((c, k) => `#${c.path.match(/\/issues\/(\d+)/)?.[1] ?? '?'} ${names[k]}`);
}

test('定期実行：止まった計画の files が1つの領域に収まれば area:* を付ける。split・2つの領域の計画には付けない', async () => {
  const labelsOf = ['type:docs', 'priority:low', 'agent:plan-review'];
  const fake = scheduleFake(
    [issue(60, 'docs: 止まった計画', labelsOf), issue(61, 'docs: split の計画', labelsOf), issue(62, 'docs: 2つの領域', labelsOf), issue(63, 'docs: 読めなかった計画', labelsOf)],
    {
      60: [gateRecord(90, stoppedRecord({}))],
      61: [gateRecord(91, stoppedRecord({ split }))],
      62: [gateRecord(92, stoppedRecord({ files: ['docs/a.md', 'harness/lib/x.ts'] }))],
      // 構造化出力を読めなかった停止（記録に plan が無い）
      63: [gateRecord(93, { version: 1, planCommentId: 80, pass: false, reasons: ['plan.risk: 値が違います'] })],
    },
  );
  await labelApply(ctxFor(fake, 'schedule', {}));
  assert.deepEqual(numbered(fake), ['#60 label+area:docs']);
});

test('定期実行：通過した計画は今まで通り files から area:* を付ける（2つの領域でも）', async () => {
  const fake = scheduleFake(
    [issue(64, 'docs: 通過した計画', ['type:docs', 'priority:low', 'agent:plan-ok'])],
    { 64: [gateRecord(94, { version: 1, planCommentId: 80, pass: true, reasons: [], plan: { ...stopped, openQuestions: [], files: ['docs/a.md', 'harness/lib/x.ts'] } })] },
  );
  await labelApply(ctxFor(fake, 'schedule', {}));
  assert.deepEqual(numbered(fake), ['#64 label+area:docs,area:harness']);
});
