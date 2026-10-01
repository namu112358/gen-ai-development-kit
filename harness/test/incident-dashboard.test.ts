// Issue #187：ダッシュボードの「改善の候補」の節（publish-queue.ts の collectIncidentComments・renderImproveSection・replaceImproveSection・improveSectionFor）と、Routine の手順（.claude/routine.md）の「改善の候補」の節
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GateContext } from '../gates/context.ts';
import { QUEUE_END, QUEUE_START } from '../gates/publish-queue.ts';
import type { IssueComment } from '../lib/github.ts';
import { renderIncidentComment, type Incident } from '../lib/incident.ts';
import { ctxFor, FakeGitHub } from './support/gate-fixtures.ts';

const root = join(import.meta.dirname, '..', '..');

interface IncidentEntry {
  url: string;
  createdAt: string;
  session: string | null;
  incidents: { kind: string; target?: string; what: string }[];
}
interface ImproveApi {
  IMPROVE_START: string;
  IMPROVE_END: string;
  collectIncidentComments: (comments: IssueComment[]) => IncidentEntry[];
  renderImproveSection: (entries: IncidentEntry[] | null) => string;
  replaceImproveSection: (body: string, section: string) => string;
  improveSectionFor: (ctx: GateContext, dashboard: number) => Promise<string>;
}

/** publish-queue.ts の改善の候補の export（まだ無いときも、ほかのテストが読み込みで巻き添えにならないよう動的に読む） */
async function load(): Promise<ImproveApi> {
  const mod = (await import('../gates/publish-queue.ts')) as Record<string, unknown>;
  for (const name of ['collectIncidentComments', 'renderImproveSection', 'replaceImproveSection', 'improveSectionFor']) {
    assert.equal(typeof mod[name], 'function', `publish-queue.ts が ${name} を export していません`);
  }
  assert.equal(mod['IMPROVE_START'], '<!-- agent-harness:improve:start -->');
  assert.equal(mod['IMPROVE_END'], '<!-- agent-harness:improve:end -->');
  return mod as unknown as ImproveApi;
}

const incident = (what: string, id = 1): Incident => ({ id, at: '2026-10-01T00:00:00.000Z', kind: 'deny', what, source: 'hook' });

function comment(id: number, body: string, association = 'OWNER'): IssueComment {
  const at = new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString();
  return { id, body, html_url: `https://github.com/o/r/issues/9#issuecomment-${id}`, created_at: at, updated_at: at, author_association: association, user: { login: 'me', type: 'User' } };
}

test('collectIncidentComments：コラボレーターの、```agent-incident が読めるコメントだけを新しい順に最大 20 件', async () => {
  const { collectIncidentComments } = await load();
  const comments: IssueComment[] = [
    comment(1, renderIncidentComment('s-1', [incident('一番古い')]), 'MEMBER'),
    comment(2, renderIncidentComment('s-2', [incident('外の人')]), 'NONE'),
    comment(3, 'ただのコメント', 'OWNER'),
    comment(4, '```agent-incident\n{壊れた\n```', 'OWNER'),
    comment(5, renderIncidentComment('s-5', [incident('新しい')]), 'COLLABORATOR'),
  ];
  const got = collectIncidentComments(comments);
  assert.deepEqual(got.map((e) => e.session), ['s-5', 's-1']);
  assert.equal(got[0]!.url, comments[4]!.html_url);
  assert.equal(got[0]!.incidents[0]!.what, '新しい');

  const many = Array.from({ length: 25 }, (_, i) => comment(i + 1, renderIncidentComment(`s-${i + 1}`, [incident(`w${i + 1}`)])));
  const top = collectIncidentComments(many);
  assert.equal(top.length, 20);
  assert.equal(top[0]!.session, 's-25');
  assert.equal(top[19]!.session, 's-6');
});

test('renderImproveSection：目印で囲み、見出しは「改善の候補」。null は読めませんでした、空は なし', async () => {
  const { renderImproveSection, IMPROVE_START, IMPROVE_END } = await load();
  for (const [entries, word] of [[null, '読めませんでした'], [[], 'なし']] as const) {
    const s = renderImproveSection(entries as IncidentEntry[] | null);
    assert.ok(s.startsWith(IMPROVE_START), s);
    assert.ok(s.trimEnd().endsWith(IMPROVE_END), s);
    assert.match(s, /### 改善の候補/);
    assert.ok(s.includes(word), s);
  }
  const s = renderImproveSection([{ url: 'https://example.test/c/1', createdAt: '2026-10-01T00:00:00Z', session: 's-1', incidents: [{ kind: 'deny', what: 'guard.ts が止めた（Bash）' }] }]);
  assert.ok(s.includes('guard.ts が止めた（Bash）'), s);
  assert.ok(s.includes('https://example.test/c/1'), s);
});

test('renderImproveSection：表示の文字列の < は &lt; にし、記録の中の目印は目印として働かない', async () => {
  const { renderImproveSection, IMPROVE_START, IMPROVE_END } = await load();
  const what = `${QUEUE_START} と ${IMPROVE_END} を含む`;
  const s = renderImproveSection([{ url: 'https://example.test/c/1', createdAt: '2026-10-01T00:00:00Z', session: 's-1', incidents: [{ kind: 'deny', what }] }]);
  assert.equal(s.includes(QUEUE_START), false, s);
  assert.equal(s.split(IMPROVE_START).length - 1, 1, s);
  assert.equal(s.split(IMPROVE_END).length - 1, 1, s);
  assert.ok(s.includes('&lt;!-- agent-harness:queue:start --&gt;') || s.includes('&lt;!-- agent-harness:queue:start -->'), s);
});

test('replaceImproveSection：目印があれば差し替え（節は1つ）、無ければ queue の節の直後、それも無ければ末尾', async () => {
  const { replaceImproveSection, renderImproveSection, IMPROVE_START } = await load();
  const oldSec = renderImproveSection(null);
  const newSec = renderImproveSection([]);
  const queue = `${QUEUE_START}\nq\n${QUEUE_END}`;

  const replaced = replaceImproveSection(`head\n${queue}\n${oldSec}\ntail`, newSec);
  assert.equal(replaced.split(IMPROVE_START).length - 1, 1, replaced);
  assert.ok(replaced.includes(newSec) && !replaced.includes('読めませんでした'), replaced);
  assert.ok(replaced.startsWith('head\n') && replaced.endsWith('\ntail'), replaced);

  const afterQueue = replaceImproveSection(`head\n${queue}\ntail`, newSec);
  const qEnd = afterQueue.indexOf(QUEUE_END) + QUEUE_END.length;
  assert.ok(afterQueue.indexOf(IMPROVE_START) >= qEnd, afterQueue);
  assert.ok(afterQueue.indexOf(IMPROVE_START) < afterQueue.indexOf('tail'), afterQueue);

  const appended = replaceImproveSection('head only', newSec);
  assert.ok(appended.startsWith('head only'), appended);
  assert.ok(appended.trimEnd().endsWith(newSec.trimEnd()), appended);
});

test('improveSectionFor：ダッシュボードのコメントを読んで節を作り、読めなくても投げずに「読めませんでした」の節を返す', async () => {
  const { improveSectionFor } = await load();
  const ok = new FakeGitHub().on('GET', /\/issues\/9\/comments/, () => [comment(1, renderIncidentComment('s-1', [incident('止められた操作')]))]);
  const s = await improveSectionFor(ctxFor(ok, 'schedule', {}), 9);
  assert.match(s, /### 改善の候補/);
  assert.ok(s.includes('止められた操作'), s);

  const ng = new FakeGitHub().on('GET', /\/issues\/9\/comments/, () => {
    throw new Error('boom');
  });
  const s2 = await improveSectionFor(ctxFor(ng, 'schedule', {}), 9);
  assert.match(s2, /### 改善の候補/);
  assert.ok(s2.includes('読めませんでした'), s2);
});

test('routine.md：「改善の候補」の節があり、incident add・incident render-comment と2つのセッションの変数が出る', () => {
  const md = readFileSync(join(root, '.claude', 'routine.md'), 'utf8');
  const m = /^(#{2,4}) [^\n]*改善の候補[^\n]*$/m.exec(md);
  assert.ok(m, 'routine.md に「改善の候補」の見出しがありません');
  const level = m[1]!.length;
  const rest = md.slice(m.index + m[0].length);
  const next = new RegExp(`^#{1,${level}} `, 'm').exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  for (const word of ['incident add', 'incident render-comment', '$CLAUDE_CODE_REMOTE_SESSION_ID', '$AGENT_HARNESS_SESSION']) {
    assert.ok(section.includes(word), `「改善の候補」の節に ${word} がありません`);
  }
});

test('improveSectionFor：全コメントは読まず、since で直近 7 日に絞り、最大 3 ページで止める（#384 の API の節約）', async () => {
  const { improveSectionFor } = await load();
  const fn = improveSectionFor as (ctx: GateContext, dashboard: number, now?: Date) => Promise<string>;
  const full = Array.from({ length: 100 }, (_, i) => comment(i + 1, 'ふつうのコメント'));
  const fake = new FakeGitHub().on('GET', /\/issues\/9\/comments/, () => full);
  await fn(ctxFor(fake, 'schedule', {}), 9, new Date('2026-10-08T00:00:00.000Z'));
  const gets = fake.calls.filter((c) => c.method === 'GET' && c.path.includes('/issues/9/comments'));
  assert.equal(gets.length, 3, gets.map((c) => c.path).join('\n'));
  for (const c of gets) assert.ok(c.path.includes(`since=${encodeURIComponent('2026-10-01T00:00:00.000Z')}`), c.path);
});
