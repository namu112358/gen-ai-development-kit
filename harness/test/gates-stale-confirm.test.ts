// Issue #963：定期実行（onSchedule）が、答えの無い確認事項（agent-confirm）をダッシュボードの節「答えの無い確認事項（直近 30 日）」に古い順に並べること。
// まとめた読み（/issues/comments?since=…）で開いた Issue / PR の候補を拾い、その番号のコメントを読み直して答えの有無を確かめる。
// 守り：確認事項があっても、書き込みはダッシュボード本文の PATCH 1回のまま（新しいコメント・ラベルを足さない）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfirmQuestion } from '../lib/confirm.ts';
import { onSchedule } from '../gates/stale.ts';
import { confirmSectionLines } from '../gates/confirm-section.ts';
import { config, ctxFor, delegateWorldFake, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { confirmCommentBody, confirmFact, confirmValue, shortAnswerBody } from './support/step-fixtures.ts';

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();
const url = (n: number, id: number) => `https://github.com/o/r/issues/${n}#issuecomment-${id}`;
const comment = (id: number, n: number, at: string, body: string, association = 'OWNER') => ({
  id, created_at: at, updated_at: at, html_url: url(n, id), issue_url: `https://api.github.com/repos/o/r/issues/${n}`,
  author_association: association, user: { login: 'me', type: 'User' }, body,
});
const confirmOn = (id: number, n: number, at: string, association = 'OWNER') =>
  comment(id, n, at, confirmCommentBody(confirmValue({ target: n, questions: [{ text: `#${n} の質問`, why: '人の決定' }] })), association);

/** 偽の GitHub。issueFacts の blockedBy（GraphQL）に空で答え、まとめた読み（/issues/comments?）を bulk(page) で返す */
function worldFake(w: DelegateWorld, bulk: (page: number) => unknown[]): FakeGitHub {
  const fake = delegateWorldFake(w);
  const request = fake.request.bind(fake);
  fake.request = async (method, path, opts = {}) => {
    if (path === '/graphql' && String((opts.body as { query?: unknown } | undefined)?.query).includes('blockedBy')) {
      fake.calls.push({ method, path, body: opts.body });
      return { data: { repository: { issue: { blockedBy: { nodes: [] } } } } };
    }
    return request(method, path, opts);
  };
  return fake.on('GET', /\/issues\/comments\?(.*)$/, (m) => bulk(Number(new URLSearchParams(m[1]!).get('page') ?? '1')));
}

async function schedule(fake: FakeGitHub): Promise<void> {
  await onSchedule(ctxFor(fake, 'schedule', {}, { config }), new Date());
}

/** ダッシュボード本文の節「答えの無い確認事項…」（見出しから次の見出しまで） */
function confirmSection(fake: FakeGitHub): string {
  const patch = fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')).at(-1);
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  const lines = String(patch.body.body).split('\n');
  const start = lines.findIndex((l) => l.startsWith('### 答えの無い確認事項（直近 30 日）'));
  assert.ok(start >= 0, `「答えの無い確認事項」の節がありません\n${patch.body.body}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('### '));
  return lines.slice(start, end >= 0 ? end : undefined).join('\n');
}
const rowsOf = (section: string) => section.split('\n').filter((l) => l.startsWith('- [#'));

test('答えの無い確認事項だけが古い順に並び（読み直しにだけ答えがある・閉じた番号・コラボレーター以外のものは並ばない）、書き込みはダッシュボードの PATCH 1回だけ', async () => {
  const c61 = confirmOn(101, 61, minutesAgo(60));
  const c62 = confirmOn(102, 62, minutesAgo(120)); // #61 より古い
  const c63 = confirmOn(103, 63, minutesAgo(90));
  const answer63 = comment(203, 63, minutesAgo(30), shortAnswerBody(103, ['はい'])); // まとめた読みには無い
  const c64 = confirmOn(104, 64, minutesAgo(80), 'NONE');
  const c70 = confirmOn(105, 70, minutesAgo(70)); // 閉じた Issue（開いた一覧に無い）
  const w: DelegateWorld = {
    prs: [], dashboardLabels: [],
    issues: { 61: [], 62: [], 63: [], 64: [] },
    comments: { 61: [c61], 62: [c62], 63: [c63, answer63], 64: [c64] },
  };
  const fake = worldFake(w, () => [c61, c64, c70, c63, c62]);
  await schedule(fake);

  const section = confirmSection(fake);
  assert.ok(section.startsWith('### 答えの無い確認事項（直近 30 日）（2）'), section);
  const rows = rowsOf(section);
  assert.equal(rows.length, 2, section);
  assert.ok(rows[0]!.startsWith(`- [#62](${c62.html_url})`), section);
  assert.ok(rows[1]!.startsWith(`- [#61](${c61.html_url})`), section);
  assert.deepEqual(fake.writes(), ['PATCH /repos/o/r/issues/1']);
});

test('まとめた読みが 10 ページとも 100 件なら、読みきれなかった行と起点（最後のコメントの created_at）が出て、11 ページ目は読まない', async () => {
  const oldest = minutesAgo(30 * 24 * 60 - 5);
  const page = (p: number) => Array.from({ length: 100 }, (_, i) => comment(10_000 + p * 100 + i, 61, p === 10 && i === 99 ? oldest : minutesAgo(p * 100 + i), 'ふつうのコメント'));
  const fake = worldFake({ prs: [], dashboardLabels: [], issues: { 61: [] } }, page);
  await schedule(fake);
  const section = confirmSection(fake);
  assert.ok(section.includes('1000 件までしか読めませんでした'), section);
  assert.ok(section.includes(`起点: ${oldest}`), section);
  assert.equal(fake.calls.filter((c) => c.method === 'GET' && c.path.includes('/issues/comments?')).length, 10);
});

test('まとめた読みが例外になると節は「読めませんでした」になり、ダッシュボードの PATCH は続く', async () => {
  const fake = worldFake({ prs: [], dashboardLabels: [] }, () => {
    throw new Error('500');
  });
  await schedule(fake);
  const section = confirmSection(fake);
  assert.ok(section.startsWith('### 答えの無い確認事項（直近 30 日）\n'), section);
  assert.ok(section.includes('読めませんでした'), section);
  assert.deepEqual(fake.writes(), ['PATCH /repos/o/r/issues/1']);
});

test('confirmSectionLines：最初の質問は 80 文字で切って … を付け、2問以上なら（ほか k 問）。起点が分からなければ「起点: 不明」', () => {
  const long = 'あ'.repeat(80) + 'い'.repeat(20);
  const questions: ConfirmQuestion[] = [{ text: long, why: 'w' }, { text: 'b', why: 'w' }, { text: 'c', why: 'w' }];
  const lines = confirmSectionLines({ rows: [{ number: 61, title: 't61', fact: confirmFact({ confirm: { questions } }) }], truncated: true, oldestAt: null });
  const row = lines.find((l) => l.startsWith('- [#61]'));
  assert.ok(row, lines.join('\n'));
  assert.ok(row.includes(`${'あ'.repeat(80)}…`) && !row.includes('い'), row);
  assert.ok(row.includes('（ほか 2 問）'), row);
  assert.ok(lines.some((l) => l.includes('起点: 不明')), lines.join('\n'));
});
