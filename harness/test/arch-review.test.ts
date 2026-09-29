import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { archReviewRange, archReviewRangeArgErrors, checkIssueDrafts, latestArchReviewRecord, parseArchReviewRecord, renderArchReviewRecord } from '../lib/arch-review.ts';
import { claudeMark } from '../lib/blocks.ts';
import { LABELS } from '../lib/config.ts';
import { GitHub } from '../lib/github.ts';
import { APP, FakeGitHub, config } from './support/gate-fixtures.ts';

// Issue #184：arch-review の記録（ダッシュボード Issue のコメント）の読み書き、対象の PR の割り出し、Issue の下書きの検査

const root = join(import.meta.dirname, '..', '..');
const SESSION = 'https://claude.ai/code/session_01ARCHREVIEWxxxxxxxxxxxxxx';
const PREV = 'c'.repeat(40);
const OLDER = 'e'.repeat(40);
const TIP = 'd'.repeat(40);
const SINCE = '1'.repeat(40);
const UNTIL = '2'.repeat(40);
const M1 = '3'.repeat(40);
const M2 = '4'.repeat(40);
const M3 = '5'.repeat(40);

const record = (patch: Record<string, unknown> = {}) => ({
  version: 1,
  baseSha: null,
  headSha: PREV,
  prs: [157, 158],
  summary: ['着手宣言の読み取りが2か所にある'],
  drafts: [{ title: 'refactor(harness): 着手宣言の読み取りを1か所にする', created: 201 }, { title: 'docs: formats.md を直す', created: null }],
  ...patch,
});

/** ```arch-review のフェンス（blocks.ts の renderBlock と同じ形。ここでは実装に頼らず組み立てる） */
const fence = (value: unknown): string => ['```arch-review', typeof value === 'string' ? value : JSON.stringify(value, null, 2), '```'].join('\n');
const recordBody = (value: unknown, mark: string = claudeMark()): string => [mark, 'arch-review の記録です。', '', fence(value)].join('\n');

let nextId = 10;
function comment(body: string, patch: Record<string, unknown> = {}) {
  const id = nextId++;
  return {
    id, body, html_url: `c${id}`, created_at: new Date(Date.UTC(2026, 8, 1) + id * 60_000).toISOString(), updated_at: '',
    author_association: 'OWNER', user: { login: 'me', type: 'User' }, ...patch,
  };
}

// ---- parseArchReviewRecord ----

test('parseArchReviewRecord：正しい記録を読める', () => {
  const r = parseArchReviewRecord(recordBody(record()));
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.record, record());
});

test('parseArchReviewRecord：baseSha が40桁の SHA でも読める', () => {
  const r = parseArchReviewRecord(recordBody(record({ baseSha: OLDER })));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.record.baseSha, OLDER);
});

test('parseArchReviewRecord：headSha が40桁でないと誤り', () => {
  for (const headSha of ['abc123', 'c'.repeat(39), 'z'.repeat(40), null]) {
    const r = parseArchReviewRecord(recordBody(record({ headSha })));
    assert.equal(r.ok, false, `headSha=${headSha}`);
  }
});

test('parseArchReviewRecord：version が 1 でないと誤り', () => {
  assert.equal(parseArchReviewRecord(recordBody(record({ version: 2 }))).ok, false);
  assert.equal(parseArchReviewRecord(recordBody(record({ version: undefined }))).ok, false);
});

test('parseArchReviewRecord：prs・summary・drafts の形が違うと誤り', () => {
  assert.equal(parseArchReviewRecord(recordBody(record({ prs: ['157'] }))).ok, false, 'prs は番号の配列');
  assert.equal(parseArchReviewRecord(recordBody(record({ summary: '一行' }))).ok, false, 'summary は文字列の配列');
  assert.equal(parseArchReviewRecord(recordBody(record({ drafts: [{ title: 'docs: a', created: '201' }] }))).ok, false, 'created は番号か null');
});

test('parseArchReviewRecord：arch-review のフェンスが2つあると誤り', () => {
  const body = [claudeMark(), fence(record()), '', fence(record())].join('\n');
  assert.equal(parseArchReviewRecord(body).ok, false);
});

test('parseArchReviewRecord：JSON が壊れていると誤り', () => {
  assert.equal(parseArchReviewRecord(recordBody('{ "version": 1, ')).ok, false);
});

test('parseArchReviewRecord：arch-review のフェンスが無いと誤り', () => {
  assert.equal(parseArchReviewRecord(`${claudeMark()}\n記録なし`).ok, false);
  assert.equal(parseArchReviewRecord(null).ok, false);
});

// ---- latestArchReviewRecord ----

test('latestArchReviewRecord：コラボレーターの Claude の目印付きの最新を選び、App・コラボレーター以外・目印なし・壊れた記録は読み飛ばす', () => {
  const older = comment(recordBody(record({ headSha: OLDER })), { author_association: 'OWNER' });
  const expected = comment(recordBody(record({ headSha: PREV })), { author_association: 'MEMBER' });
  const later = [
    comment(recordBody(record({ headSha: M1 })), { author_association: 'OWNER', user: { login: APP, type: 'Bot' } }),
    comment(recordBody(record({ headSha: M2 })), { author_association: 'CONTRIBUTOR' }),
    comment(recordBody(record({ headSha: M3 })), { author_association: 'NONE' }),
    comment(['arch-review の記録です。', '', fence(record({ headSha: TIP }))].join('\n')),
    comment(recordBody('{ broken')),
    comment(recordBody(record({ headSha: 'short' }))),
  ];
  const r = latestArchReviewRecord([older, expected, ...later], config);
  assert.ok(r, '前回の記録が見つかりません');
  assert.equal(r.record.headSha, PREV);
  assert.equal(r.comment.id, expected.id);
});

test('latestArchReviewRecord：COLLABORATOR の記録も読み、ID 付きの目印も読める', () => {
  const c = comment(recordBody(record(), claudeMark(SESSION)), { author_association: 'COLLABORATOR' });
  assert.equal(latestArchReviewRecord([c], config)?.record.headSha, PREV);
});

test('latestArchReviewRecord：エンティティの形の目印（&lt;!-- … --&gt;）も読める', () => {
  const c = comment(recordBody(record(), '&lt;!-- agent-harness:claude --&gt;'));
  assert.equal(latestArchReviewRecord([c], config)?.record.headSha, PREV);
});

test('latestArchReviewRecord：読める記録が無ければ null', () => {
  assert.equal(latestArchReviewRecord([], config), null);
  assert.equal(latestArchReviewRecord([comment('ふつうのコメント'), comment(recordBody(record()), { author_association: 'NONE' })], config), null);
});

// ---- renderArchReviewRecord ----

test('renderArchReviewRecord：出力を parseArchReviewRecord で読み戻せ、先頭が目印で、```agent- を含まない', () => {
  const value = record({ baseSha: OLDER });
  const body = renderArchReviewRecord(value, SESSION);
  assert.ok(body.startsWith(claudeMark(SESSION)), '先頭がセッション ID 付きの Claude の目印ではありません');
  const r = parseArchReviewRecord(body);
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.record, value);
  assert.ok(!body.includes('```agent-'), 'gate.yml の if: に当たる ```agent- を含みます');
  assert.ok(!body.includes('agent-harness:app'), 'App の目印を含みます');
});

test('renderArchReviewRecord：セッション ID が無ければ ID の無い目印になる', () => {
  assert.ok(renderArchReviewRecord(record(), null).startsWith(claudeMark(null)));
});

test('renderArchReviewRecord：人が読む要約（summary）と作った Issue の番号が本文に出る', () => {
  const body = renderArchReviewRecord(record(), SESSION);
  assert.ok(body.includes('着手宣言の読み取りが2か所にある'), 'summary が本文にありません');
  assert.ok(body.includes('#201'), '作った Issue の番号が本文にありません');
});

test('renderArchReviewRecord で書いた記録を、次の実行の latestArchReviewRecord が前回として読める', () => {
  const before = comment(recordBody(record()));
  const written = comment(renderArchReviewRecord(record({ headSha: TIP }), SESSION));
  const r = latestArchReviewRecord([before, written], config);
  assert.equal(r?.record.headSha, TIP);
});

// ---- archReviewRange ----

interface RangeWorld {
  dashboard?: boolean;
  comments?: unknown[];
  commits?: { sha: string; message: string }[];
  totalCommits?: number;
  pulls?: Record<number, Record<string, unknown>>;
  commitPulls?: Record<string, Record<string, unknown>[]>;
  closed?: Record<string, unknown>[];
}

const mergedPr = (number: number, mergedAt: string, patch: Record<string, unknown> = {}) => ({
  number, title: `feat(harness): PR ${number}`, state: 'closed', merge_commit_sha: String(number % 10).repeat(40), merged_at: mergedAt,
  base: { ref: 'main' }, head: { ref: `claude/issue-${number}` }, ...patch,
});

function rangeFake(w: RangeWorld): FakeGitHub {
  const page = (path: string): number => Number(path.match(/[?&]page=(\d+)/)?.[1] ?? '1');
  return new FakeGitHub()
    .on('GET', /\/issues\?state=open&creator=/, () => (w.dashboard === false ? [] : [{ number: 1, title: config.dashboardIssueTitle, user: { login: APP }, labels: [] }]))
    .on('GET', /\/issues\/1\/comments/, () => w.comments ?? [])
    // 既定ブランチの先頭（どの API で読んでも同じ SHA）
    .on('GET', /\/(?:branches|commits|git\/ref\/heads|git\/refs\/heads)\/main(?:\?.*)?$/, () => ({ name: 'main', sha: TIP, commit: { sha: TIP }, object: { sha: TIP } }))
    .on('GET', /\/compare\/([^/?]+?)\.\.\.([^/?]+)/, (m, _b, o) => {
      if (o.raw) return '';
      const commits = page(m.input!) > 1 ? [] : (w.commits ?? []);
      return {
        status: 'ahead', ahead_by: w.totalCommits ?? (w.commits ?? []).length, total_commits: w.totalCommits ?? (w.commits ?? []).length,
        commits: commits.map((c) => ({ sha: c.sha, commit: { message: c.message, committer: { date: '2026-09-10T00:00:00Z' } } })),
      };
    })
    .on('GET', /\/pulls\/(\d+)$/, (m) => w.pulls?.[Number(m[1])] ?? mergedPr(Number(m[1]), '2026-09-10T00:00:00Z'))
    .on('GET', /\/commits\/([0-9a-f]{40})\/pulls/, (m) => w.commitPulls?.[m[1]!] ?? [])
    .on('GET', /\/pulls\?(?:.*&)?state=closed/, (m) => {
      if (page(m.input!) > 1) return [];
      const base = m.input!.match(/[?&]base=([^&]+)/)?.[1];
      return (w.closed ?? []).filter((p: any) => !base || p.base.ref === decodeURIComponent(base));
    });
}

const ghFor = (fake: FakeGitHub): GitHub => new GitHub(fake, 'o/r');
const comparePaths = (fake: FakeGitHub): string[] => fake.calls.filter((c) => c.method === 'GET' && c.path.includes('/compare/')).map((c) => c.path);

/** 前回の記録（headSha = PREV）と、PREV...TIP の3つのコミット（squash の件名の番号・/commits/{sha}/pulls・PR の無い直接の push） */
function worldWithPrevious(): RangeWorld {
  return {
    comments: [comment(recordBody(record({ headSha: PREV })))],
    commits: [
      { sha: M1, message: 'feat(harness): 着手宣言を足す (#157)\n\n本文' },
      { sha: M2, message: 'fix: 件名に番号の無い Merge' },
      { sha: M3, message: 'chore: PR の無い直接の push' },
    ],
    pulls: {
      157: mergedPr(157, '2026-09-10T00:00:00Z', { title: 'feat(harness): 着手宣言を足す', merge_commit_sha: M1 }),
      158: mergedPr(158, '2026-09-11T00:00:00Z', { title: 'fix: 件名に番号の無い Merge', merge_commit_sha: M2 }),
    },
    commitPulls: {
      [M2]: [mergedPr(158, '2026-09-11T00:00:00Z', { title: 'fix: 件名に番号の無い Merge', merge_commit_sha: M2 })],
      [M3]: [],
    },
  };
}

test('archReviewRange：前回の記録の headSha から既定ブランチの先頭までの compare のコミットを PR に対応させる', async () => {
  const fake = rangeFake(worldWithPrevious());
  const r = await archReviewRange(ghFor(fake), config, {});
  assert.equal(r.source, 'previous');
  assert.equal(r.previous?.headSha, PREV);
  assert.equal(r.baseSha, PREV);
  assert.equal(r.headSha, TIP);
  assert.equal(r.truncated, false);
  assert.deepEqual([...r.prs].sort((a, b) => a.number - b.number), [
    { number: 157, title: 'feat(harness): 着手宣言を足す', mergeCommitSha: M1, mergedAt: '2026-09-10T00:00:00Z' },
    { number: 158, title: 'fix: 件名に番号の無い Merge', mergeCommitSha: M2, mergedAt: '2026-09-11T00:00:00Z' },
  ]);
  assert.ok(comparePaths(fake).some((p) => p.includes(`/compare/${PREV}...${TIP}`)), `compare の範囲が違います：${comparePaths(fake).join(', ')}`);
  assert.ok(fake.calls.some((c) => c.path.includes(`/commits/${M2}/pulls`)), '件名に番号の無いコミットは /commits/{sha}/pulls で PR を探す');
});

test('archReviewRange：前回の記録が無ければ、既定ブランチ宛ての Merge 済みの PR を新しい順に10本（未 Merge の closed と別のブランチ宛てを除く）', async () => {
  const closed = [
    ...Array.from({ length: 12 }, (_, i) => mergedPr(100 + i, `2026-09-${String(i + 1).padStart(2, '0')}T00:00:00Z`)),
    mergedPr(150, '', { merged_at: null }),
    mergedPr(151, '2026-09-28T00:00:00Z', { base: { ref: 'other' } }),
  ].reverse();
  const fake = rangeFake({ comments: [], closed });
  const r = await archReviewRange(ghFor(fake), config, {});
  assert.equal(r.source, 'last');
  assert.equal(r.previous, null);
  assert.equal(r.headSha, TIP);
  assert.deepEqual(r.prs.map((p) => p.number), [111, 110, 109, 108, 107, 106, 105, 104, 103, 102]);
  assert.equal(comparePaths(fake).length, 0, '前回が無ければ compare を読まない');
});

test('archReviewRange：Merge の新しい順は merged_at で決める（一覧の並びに頼らない）', async () => {
  const closed = [mergedPr(201, '2026-09-01T00:00:00Z'), mergedPr(203, '2026-09-03T00:00:00Z'), mergedPr(202, '2026-09-02T00:00:00Z')];
  const r = await archReviewRange(ghFor(rangeFake({ closed })), config, { last: 3 });
  assert.deepEqual(r.prs.map((p) => p.number), [203, 202, 201]);
});

test('archReviewRange：--since があれば前回の記録より優先して、その SHA から compare する', async () => {
  const fake = rangeFake(worldWithPrevious());
  const r = await archReviewRange(ghFor(fake), config, { since: SINCE });
  assert.equal(r.source, 'since');
  assert.equal(r.baseSha, SINCE);
  assert.equal(r.headSha, TIP);
  assert.ok(comparePaths(fake).some((p) => p.includes(`/compare/${SINCE}...${TIP}`)), comparePaths(fake).join(', '));
  assert.ok(!comparePaths(fake).some((p) => p.includes(PREV)), '--since があれば前回の headSha から compare しない');
});

test('archReviewRange：--until があれば既定ブランチの先頭の代わりにその SHA まで compare する', async () => {
  const fake = rangeFake(worldWithPrevious());
  const r = await archReviewRange(ghFor(fake), config, { until: UNTIL });
  assert.equal(r.baseSha, PREV);
  assert.equal(r.headSha, UNTIL);
  assert.ok(comparePaths(fake).some((p) => p.includes(`/compare/${PREV}...${UNTIL}`)), comparePaths(fake).join(', '));
});

test('archReviewRange：--since と --until を両方渡すと、その範囲だけを見る', async () => {
  const fake = rangeFake(worldWithPrevious());
  const r = await archReviewRange(ghFor(fake), config, { since: SINCE, until: UNTIL });
  assert.equal(r.baseSha, SINCE);
  assert.equal(r.headSha, UNTIL);
  assert.ok(comparePaths(fake).some((p) => p.includes(`/compare/${SINCE}...${UNTIL}`)), comparePaths(fake).join(', '));
});

test('archReviewRange：--last があれば前回の記録があっても直近 N 本にする', async () => {
  const world = worldWithPrevious();
  world.closed = [mergedPr(170, '2026-09-20T00:00:00Z'), mergedPr(171, '2026-09-21T00:00:00Z'), mergedPr(172, '2026-09-22T00:00:00Z')];
  const fake = rangeFake(world);
  const r = await archReviewRange(ghFor(fake), config, { last: 2 });
  assert.equal(r.source, 'last');
  assert.deepEqual(r.prs.map((p) => p.number), [172, 171]);
  assert.equal(comparePaths(fake).length, 0, '--last のときは compare を読まない');
});

test('archReviewRange：compare の上限（250 件）に当たれば truncated が真になる', async () => {
  const commits = Array.from({ length: 250 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(40, '0'), message: `feat: PR ${300 + i} (#${300 + i})` }));
  const r = await archReviewRange(ghFor(rangeFake({ comments: [comment(recordBody(record()))], commits, totalCommits: 400 })), config, {});
  assert.equal(r.truncated, true);
});

test('archReviewRange：ダッシュボードが無ければ前回なしとして直近 N 本にし、そのことを note に書く', async () => {
  const fake = rangeFake({ dashboard: false, closed: [mergedPr(180, '2026-09-20T00:00:00Z')] });
  const r = await archReviewRange(ghFor(fake), config, {});
  assert.equal(r.previous, null);
  assert.equal(r.source, 'last');
  assert.deepEqual(r.prs.map((p) => p.number), [180]);
  assert.equal(typeof r.note, 'string');
  assert.ok((r.note ?? '').length > 0, 'note が空です');
  assert.ok(!fake.calls.some((c) => c.path.includes('/issues/1/comments')), 'ダッシュボードが無いのにコメントを読んでいます');
});

test('archReviewRange：GitHub に書き込まない（読むだけ）', async () => {
  const fake = rangeFake(worldWithPrevious());
  await archReviewRange(ghFor(fake), config, {});
  assert.deepEqual(fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`), []);
});

// ---- checkIssueDrafts ----

const BODY = ['### Goal', '', '着手宣言の読み取りを1か所にする', '', '### Requirements', '', '- claimOf を使う', '', '### Acceptance Criteria', '', '- [ ] 重複が無い'].join('\n');
const draft = (patch: Record<string, unknown> = {}) => ({ title: 'refactor(harness): 着手宣言の読み取りを1か所にする', body: BODY, ...patch });

test('checkIssueDrafts：正しい下書きは、タイトルを並べた一覧の Markdown になる（開いた Issue と同じものはその番号も出す）', () => {
  const r = checkIssueDrafts([draft(), draft({ title: 'docs: formats.md の着手宣言の節を直す', duplicateOf: 123 })]);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.drafts.length, 2);
  assert.ok(r.markdown.includes('refactor(harness): 着手宣言の読み取りを1か所にする'), r.markdown);
  assert.ok(r.markdown.includes('docs: formats.md の着手宣言の節を直す'), r.markdown);
  assert.ok(r.markdown.includes('#123'), '同じものがある開いた Issue の番号が一覧にありません');
});

test('checkIssueDrafts：Issue Form の必須の見出し（Goal・Requirements・Acceptance Criteria）が欠けると誤り', () => {
  const noAc = BODY.split('### Acceptance Criteria')[0]!;
  const r = checkIssueDrafts([draft({ body: noAc })]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes('Acceptance Criteria')), JSON.stringify(r));
  const noGoal = BODY.replace('### Goal', '### Background');
  assert.equal(checkIssueDrafts([draft({ body: noGoal })]).ok, false);
});

test('checkIssueDrafts：Conventional Commits でないタイトルは誤り', () => {
  assert.equal(checkIssueDrafts([draft({ title: '着手宣言の読み取りを1か所にする' })]).ok, false);
  assert.equal(checkIssueDrafts([draft({ title: 'Refactor: x' })]).ok, false);
});

test('checkIssueDrafts：labels に agent:ready を含む下書きは誤り', () => {
  const r = checkIssueDrafts([draft({ labels: [LABELS.ready] })]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.errors.some((e) => e.includes(LABELS.ready)), JSON.stringify(r));
});

test('checkIssueDrafts：配列でない・title や body が文字列でないと誤り', () => {
  assert.equal(checkIssueDrafts({ title: 'docs: a', body: BODY }).ok, false);
  assert.equal(checkIssueDrafts([{ body: BODY }]).ok, false);
  assert.equal(checkIssueDrafts([{ title: 'docs: a', body: 1 }]).ok, false);
});

// ---- agent.ts arch-review-drafts ----

const runDrafts = (value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'arch-review-'));
  const file = join(dir, 'drafts.json');
  writeFileSync(file, JSON.stringify(value));
  return spawnSync(process.execPath, ['harness/scripts/agent.ts', 'arch-review-drafts', file], { cwd: root, encoding: 'utf8' });
};

test('agent.ts arch-review-drafts：正しい下書きは一覧を出して終了コード 0', () => {
  const r = runDrafts([draft()]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('refactor(harness): 着手宣言の読み取りを1か所にする'), r.stdout);
});

test('agent.ts arch-review-drafts：agent:ready を含む下書きは終了コード 2', () => {
  const r = runDrafts([draft({ labels: [LABELS.ready] })]);
  assert.equal(r.status, 2, r.stdout);
});

test('archReviewRangeArgErrors：--last は2桁以上の整数も受け付け、0・負・小数・文字は誤り。--since・--until は40桁の SHA', () => {
  assert.deepEqual(archReviewRangeArgErrors({}), []);
  for (const last of ['1', '9', '10', '25', '100']) assert.deepEqual(archReviewRangeArgErrors({ last }), [], last);
  for (const last of ['0', '-1', '1.5', 'd', 'dd', '1d', '']) assert.deepEqual(archReviewRangeArgErrors({ last }), ['--last は1以上の整数'], last);
  const sha = 'a'.repeat(40);
  assert.deepEqual(archReviewRangeArgErrors({ since: sha, until: sha }), []);
  assert.deepEqual(archReviewRangeArgErrors({ since: 'abc', until: sha.toUpperCase() }), ['--since は40桁の SHA', '--until は40桁の SHA']);
});
