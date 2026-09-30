// Issue #249：judge-input の過去の PR（pastPrsFor）を、ファイルの履歴1回（PastPrHistories）と PR のコメント・レビュー1回（PastPrThreads）の GraphQL の問い合わせで読んでも、前の REST の読み方と同じ PastPrs・renderPastPrs になる（ファイル名は変数・続きのある PR は REST で読み直す・新しいファイル・作者の無いコメント）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark } from '../lib/blocks.ts';
import { GitHub } from '../lib/github.ts';
import { pastPrsFor } from '../lib/past-pr-reads.ts';
import { PAST_PR_FILE_LIMIT, type PastPrReview, type PastPrReviewComment, type PastPrs, renderPastPrs, selectPastPrs } from '../lib/session-inputs.ts';
import { config } from './support/gate-fixtures.ts';
import { callNames } from './support/dashboard-fixtures.ts';
import { type HistoryPr, type PastPrWorld, type PastWorld, pastPrFake, REPO } from './support/judge-graphql-fixtures.ts';

const SELF = 500;
const BIG = 5902898007;
const APP_ACTOR = { login: config.appSlug, bot: true };
const T = (d: number, h = 0) => `2026-09-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;
const merged = (number: number, day: number, base = 'main'): HistoryPr => ({ number, title: `past ${number}`, merged: true, mergedAt: T(day), baseRefName: base });

/** judge.ts の前の FILE_HISTORY_QUERY（ファイルごとに1回） */
const FILE_HISTORY_QUERY = `query($owner: String!, $name: String!, $branch: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $branch) {
      ... on Commit {
        history(first: 5, path: $path) { nodes { associatedPullRequests(first: 5) { nodes { number title merged mergedAt baseRefName } } } }
      }
    }
  }
}`;
type HistoryNode = { associatedPullRequests: { nodes: HistoryPr[] } };

/** #249 の前の judge.ts の pastPrsFor（ファイルごとの GraphQL と、PR ごとの REST）をそのまま書き直したもの。正解を作る */
async function restPastPrs(gh: GitHub, n: number): Promise<PastPrs> {
  const changed = (await gh.paginate<{ filename: string }>(`/pulls/${n}/files`)).map((f) => f.filename);
  const considered = changed.slice(0, PAST_PR_FILE_LIMIT);
  const histories: Parameters<typeof selectPastPrs>[0] = [];
  for (const path of considered) {
    const data = await gh.graphql<{ repository: { object: { history?: { nodes: HistoryNode[] } } | null } }>(
      FILE_HISTORY_QUERY, { owner: gh.owner, name: gh.repo, branch: config.defaultBranch, path },
    );
    const nodes = data.repository.object?.history?.nodes ?? [];
    histories.push({ path, prs: nodes.flatMap((c) => c.associatedPullRequests.nodes) });
  }
  const prs: PastPrs['prs'] = [];
  for (const p of selectPastPrs(histories, n, config.defaultBranch)) {
    prs.push({
      number: p.number, title: p.title, mergedAt: p.mergedAt, files: p.files,
      comments: await gh.listComments(p.number),
      reviews: await gh.paginate<PastPrReview>(`/pulls/${p.number}/reviews`),
      reviewComments: await gh.paginate<PastPrReviewComment>(`/pulls/${p.number}/comments`),
    });
  }
  return { changedFiles: changed.length, filesConsidered: considered.length, prs };
}

/** 引用符・$・波かっこを含むファイル名（問い合わせの文字列に埋め込むと壊れる） */
const ODD = 'docs/a "quoted" $x{}.md';
const FILES = [ODD, ...Array.from({ length: 31 }, (_, k) => `src/f${k + 1}.ts`)];

/**
 * 見本：変更ファイル32件（先頭30件だけ調べる）。履歴には、Merge 済みの main への PR（12件。上限の10件を超える）、Merge されていない PR、別のブランチへの PR、判定する PR 自身、
 * 31件目のファイルだけが触った PR（調べない）が混ざる。src/f3.ts は新しいファイル（履歴が空）。
 * #101 は人・App・Claude の目印・作者の無いコメント（関係 NONE）・2^31 を超える ID・行の無いレビューコメント、
 * #102 はコメント150件（続きがある）、#105 はレビューコメント105件のレビュー（入れ子の接続に続きがある）
 */
function baseWorld(): PastWorld {
  const histories: Record<string, HistoryPr[][]> = {
    [ODD]: [[merged(101, 10), merged(102, 11)], [merged(101, 10)]],
    'src/f1.ts': [[merged(102, 11), { number: 103, title: 'not merged', merged: false, mergedAt: null, baseRefName: 'main' }], [merged(104, 12, 'develop')]],
    'src/f2.ts': [[merged(SELF, 20)], [merged(105, 13)], [merged(106, 14), merged(107, 15)]],
    'src/f4.ts': [[merged(108, 16)], [merged(109, 17)], [merged(110, 18)], [merged(111, 19)], [merged(112, 9)], [merged(113, 8)]],
    'src/f5.ts': [[merged(101, 10), merged(114, 7)]],
    'src/f31.ts': [[merged(199, 25)]],
  };
  const human = (id: number, body: string, at: string, extra: Record<string, unknown> = {}) => ({ id, body, created_at: at, author: { login: 'me' }, association: 'OWNER', ...extra });
  const prs: PastPrWorld[] = [
    {
      number: 101,
      comments: [
        human(BIG, '人の指摘です', T(9, 1)),
        { id: BIG + 1, body: [appMark('acceptance'), 'App'].join('\n'), created_at: T(9, 2), author: APP_ACTOR, association: 'NONE' },
        { id: BIG + 2, body: [claudeMark(), 'Claude の判定'].join('\n'), created_at: T(9, 3), author: { login: 'me' }, association: 'OWNER' },
        { id: BIG + 3, body: '作者の無いコメント', created_at: T(9, 4), author: null, association: 'NONE' },
        { id: BIG + 4, body: '外の人', created_at: T(9, 5), author: { login: 'stranger' }, association: 'CONTRIBUTOR' },
        { id: BIG + 5, body: '   ', created_at: T(9, 6) },
      ],
      reviews: [
        {
          id: BIG + 10, state: 'COMMENTED', body: 'レビューの本文', submitted_at: T(9, 7), author: { login: 'rev' }, association: 'MEMBER',
          comments: [
            { id: BIG + 21, body: '後の行コメント', path: ODD, line: 3, created_at: T(9, 9) },
            { id: BIG + 20, body: '先の行コメント', path: ODD, line: 1, created_at: T(9, 8) },
            { id: BIG + 22, body: '古い行のコメント', path: 'src/f5.ts', line: null, original_line: 7, created_at: T(9, 8) },
          ],
        },
        { id: BIG + 11, state: 'APPROVED', body: '', submitted_at: T(9, 10), author: APP_ACTOR, association: 'NONE' },
        {
          id: BIG + 12, state: 'CHANGES_REQUESTED', body: '二つ目のレビュー', submitted_at: T(9, 11), author: null, association: 'NONE',
          comments: [{ id: BIG + 19, body: '作者の無い行コメント', path: ODD, line: 2, created_at: T(9, 8), author: null, association: 'NONE' }],
        },
      ],
    },
    {
      number: 102,
      comments: Array.from({ length: 150 }, (_, k) => human(BIG + 1000 + k, `コメント ${k}`, T(10, k % 24), { created_at: `2026-09-10T00:${String(Math.floor(k / 60)).padStart(2, '0')}:${String(k % 60).padStart(2, '0')}Z` })),
      reviews: [{ id: BIG + 1200, state: 'COMMENTED', body: '102 のレビュー', submitted_at: T(10, 5) }],
    },
    {
      number: 105,
      comments: [human(BIG + 2000, '105 のコメント', T(12, 1))],
      reviews: [{
        id: BIG + 2100, state: 'COMMENTED', body: '105 のレビュー', submitted_at: T(12, 2),
        comments: Array.from({ length: 105 }, (_, k) => ({ id: BIG + 2200 + k, body: `行 ${k}`, path: 'src/f2.ts', line: k + 1, created_at: `2026-09-12T03:00:${String(k % 60).padStart(2, '0')}Z` })),
      }],
    },
    ...[104, 106, 107, 108, 109, 110, 111, 112, 113, 114, 199].map((number) => ({ number, comments: [human(BIG + number * 10, `#${number} のコメント`, T(5, 1))] })),
  ];
  return { pr: SELF, files: FILES, histories, prs };
}

async function bothWays(world: PastWorld) {
  const restFake = pastPrFake(world);
  const expected = await restPastPrs(new GitHub(restFake, REPO), world.pr);
  const fake = pastPrFake(world);
  const got = await pastPrsFor(new GitHub(fake, REPO), config, world.pr);
  return { expected, got, fake };
}

const graphqlBodies = (fake: ReturnType<typeof pastPrFake>, name: string) =>
  fake.calls.filter((c) => c.path === '/graphql' && new RegExp(`^\\s*query ${name}\\(`).test(String(c.body?.query))).map((c) => c.body as { query: string; variables: Record<string, unknown> });

test('pastPrsFor：まとめた GraphQL の問い合わせで読んだ PastPrs と renderPastPrs の文字列が、前の REST の読み方と同じ', async () => {
  const { expected, got } = await bothWays(baseWorld());
  assert.deepEqual(got, expected);
  assert.equal(renderPastPrs(config, got).join('\n'), renderPastPrs(config, expected).join('\n'));

  // 見本が確かめたい値を実際に含んでいる
  assert.equal(expected.changedFiles, 32);
  assert.equal(expected.filesConsidered, 30);
  assert.equal(expected.prs.length, 10, '候補は12件で、上限の10件');
  assert.ok(!expected.prs.some((p) => [103, 104, SELF, 199].includes(p.number)), 'Merge されていない・別のブランチ・自身・調べないファイルだけの PR は入らない');
  const p101 = expected.prs.find((p) => p.number === 101)!;
  assert.deepEqual(p101.files, [ODD, 'src/f5.ts']);
  assert.equal(p101.comments[0]!.id, BIG);
  assert.ok(p101.comments.some((c) => c.user === null), '作者の無いコメント');
  assert.deepEqual(p101.reviewComments.map((c) => c.id), [BIG + 19, BIG + 20, BIG + 22, BIG + 21], 'created_at → id の順');
  assert.equal(expected.prs.find((p) => p.number === 102)!.comments.length, 150);
  assert.equal(expected.prs.find((p) => p.number === 105)!.reviewComments.length, 105);
  const text = renderPastPrs(config, got).join('\n');
  assert.match(text, /人の指摘です/);
  assert.match(text, /レビューの本文/);
  assert.match(text, /先の行コメント/);
});

test('pastPrsFor：ファイルの履歴は1回の問い合わせ（PastPrHistories）で読み、ファイル名は問い合わせの文字列に含めず変数で渡す。前のファイルごとの問い合わせは送らない', async () => {
  const world = baseWorld();
  const { fake } = await bothWays(world);
  const histories = graphqlBodies(fake, 'PastPrHistories');
  assert.equal(histories.length, 1);
  const { query, variables } = histories[0]!;
  for (const f of FILES) assert.ok(!query.includes(f), `ファイル名が問い合わせにある：${f}`);
  assert.ok(!query.includes('quoted'));
  assert.equal(variables.owner, 'o');
  assert.equal(variables.name, 'r');
  assert.equal(variables.branch, config.defaultBranch);
  const paths = Object.keys(variables).filter((k) => /^p\d+$/.test(k)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  assert.deepEqual(paths.map((k) => variables[k]), FILES.slice(0, PAST_PR_FILE_LIMIT), '先頭30件を $p0… で渡す');
  assert.equal(graphqlBodies(fake, 'PastPrThreads').length, 1, '過去の PR のコメント・レビューも1回');
  assert.ok(!fake.calls.some((c) => c.path === '/graphql' && String(c.body?.query).includes('$path')), '前のファイルごとの問い合わせは送らない');
  assert.deepEqual(callNames(fake).filter((n) => n === 'graphql:anonymous'), []);
});

test('pastPrsFor：過去の PR の番号は PastPrThreads の変数（$n0…）で渡し、選んだ PR だけを読む', async () => {
  const { expected, fake } = await bothWays(baseWorld());
  const [threads] = graphqlBodies(fake, 'PastPrThreads');
  assert.doesNotMatch(threads!.query, /pullRequest\s*\(\s*number\s*:\s*\d/, '番号を問い合わせに埋め込まない');
  const numbers = Object.entries(threads!.variables).filter(([k]) => /^n\d+$/.test(k)).map(([, v]) => v as number);
  assert.deepEqual([...numbers].sort((a, b) => a - b), expected.prs.map((p) => p.number).sort((a, b) => a - b));
});

test('pastPrsFor：コメント・レビュー・レビューごとのコメントの接続に続きがある PR だけを REST で読み直し、150件・105件を全部読む', async () => {
  const { expected, got, fake } = await bothWays(baseWorld());
  assert.deepEqual(got, expected);
  const restPrs = new Set(callNames(fake).flatMap((n) => {
    const m = n.match(/^GET \/(?:issues|pulls)\/(\d+)\/(?:comments|reviews)$/);
    return m ? [Number(m[1])] : [];
  }));
  assert.deepEqual([...restPrs].sort((a, b) => a - b), [102, 105], 'REST で読み直すのは続きのある PR だけ');
  const p102 = got.prs.find((p) => p.number === 102)!;
  assert.equal(p102.comments.length, 150);
  assert.deepEqual(p102.comments.map((c) => c.id), Array.from({ length: 150 }, (_, k) => BIG + 1000 + k));
  assert.equal(got.prs.find((p) => p.number === 105)!.reviewComments.length, 105);
});

test('pastPrsFor：新しいファイル（履歴が空）だけの PR・既定のブランチが読めない（object が null）ときも、前の読み方と同じ', async () => {
  const fresh: PastWorld = { pr: SELF, files: ['new/a.ts', 'new/b.ts'], histories: {}, prs: [] };
  const a = await bothWays(fresh);
  assert.deepEqual(a.got, a.expected);
  assert.deepEqual(a.expected, { changedFiles: 2, filesConsidered: 2, prs: [] });
  assert.equal(renderPastPrs(config, a.got).join('\n'), renderPastPrs(config, a.expected).join('\n'));

  const mixed = baseWorld();
  mixed.files = ['src/f3.ts', 'src/f2.ts'];
  const b = await bothWays(mixed);
  assert.deepEqual(b.got, b.expected);
  assert.deepEqual(b.expected.prs.map((p) => p.number), [107, 106, 105]);

  const noBranch = { ...baseWorld(), noBranch: true };
  const c = await bothWays(noBranch);
  assert.deepEqual(c.got, c.expected);
  assert.deepEqual(c.expected.prs, []);

  const none: PastWorld = { pr: SELF, files: [], prs: [] };
  const d = await bothWays(none);
  assert.deepEqual(d.got, d.expected);
});

test('pastPrsFor：作者の無い（author: null、関係 NONE）コメント・レビュー・レビューコメントだけの PR でも出力が同じ', async () => {
  const world: PastWorld = {
    pr: SELF, files: ['docs/x.md'], histories: { 'docs/x.md': [[merged(120, 10)]] },
    prs: [{
      number: 120,
      comments: [{ id: BIG, body: '作者の無いコメント', author: null, association: 'NONE' }, { id: BIG + 1, body: '人のコメント', author: { login: 'me' }, association: 'OWNER' }],
      reviews: [{ id: BIG + 2, state: 'COMMENTED', body: '作者の無いレビュー', author: null, association: 'NONE', comments: [{ id: BIG + 3, body: '作者の無い行', path: 'docs/x.md', line: 1, author: null, association: 'NONE' }] }],
    }],
  };
  const { expected, got } = await bothWays(world);
  assert.deepEqual(got, expected);
  const text = renderPastPrs(config, got).join('\n');
  assert.equal(text, renderPastPrs(config, expected).join('\n'));
  assert.equal(got.prs[0]!.comments[0]!.user, null);
  assert.equal(got.prs[0]!.reviews[0]!.user, null);
  assert.equal(got.prs[0]!.reviewComments[0]!.user, null);
  assert.match(text, /人のコメント/);
  assert.doesNotMatch(text, /作者の無い/);
});
