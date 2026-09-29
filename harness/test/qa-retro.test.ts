// Issue #185：品質の振り返り（qa-retro）の集計。GitHub の応答を FakeGitHub に固定し、PR ごとの risk・Merge の経路・後追いの修正・revert・CI の再実行・メトリクスを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appMark, claudeMark, renderBlock } from '../lib/blocks.ts';
import { GitHub, HttpError, type IssueComment, type RequestOptions } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import {
  collectQaRetro, mergeRouteOf, parseFailedTestNames, parseMetricsTables, parseQaRetroArgs, sumMetrics, summarizeQaRetro,
  type MetricRow, type QaRetroData, type QaRetroPr,
} from '../lib/qa-retro.ts';
import { APP, config, FakeGitHub } from './support/gate-fixtures.ts';

// --- 期間と日付 ---

const SINCE = new Date('2026-09-15T00:00:00Z');
const UNTIL = new Date('2026-09-29T00:00:00Z');
const PERIOD = { since: SINCE, until: UNTIL };
/** 2026-09 の day 日 hour 時（UTC） */
const sep = (day: number, hour = 12): string => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

// --- コメント・レビュー ---

let nextId = 1;

function comment(body: string, association = 'OWNER', login = 'me'): IssueComment {
  const id = nextId++;
  return { id, body, html_url: `c${id}`, created_at: sep(20), updated_at: '', author_association: association, user: { login, type: 'User' } };
}

/** App の記録（目印と agent-app ブロック）。login を変えると App 以外の名義の偽物になる */
function appComment(kind: string, value: unknown, login = APP): IssueComment {
  const id = nextId++;
  return {
    id, body: `${appMark(kind)}\n記録\n${renderBlock('agent-app', value)}`, html_url: `c${id}`, created_at: sep(20), updated_at: '',
    author_association: 'NONE', user: { login, type: login === APP ? 'Bot' : 'User' },
  };
}

function acceptance(patch: Partial<Acceptance> = {}): Acceptance {
  return {
    version: 1, verdictCommentId: 1, verdictHeadSha: 'a'.repeat(40), patchId: 'p', reviewPass: true, riskLevel: 'low', riskOk: true,
    scopeOk: true, outside: [], autoEligible: true, reasons: [], ...patch,
  };
}

const acceptanceComment = (patch: Partial<Acceptance> = {}): IssueComment => appComment('acceptance', acceptance(patch));
const delegatedMergeComment = (login = APP): IssueComment =>
  appComment('delegated-merge', { version: 1, headSha: 'a'.repeat(40), patchId: 'p', since: null, until: null, by: 'me', skipped: [] }, login);

/** /pulls/{n}/reviews の1件。App の fix-request は本文の先頭に目印を持つ */
function fixRequestReview(login = APP) {
  const id = nextId++;
  return {
    id, state: 'CHANGES_REQUESTED', submitted_at: sep(20), commit_id: 'a'.repeat(40), html_url: `r${id}`, author_association: 'NONE',
    user: { login, type: login === APP ? 'Bot' : 'User' },
    body: '<!-- agent-harness:app kind=fix-request -->\nReviewer のブロッキング指摘（修正 1 回目）。修正して push してください。\n\n- **bug**: x',
  };
}

// --- メトリクスの表（agent.ts の render-metrics と appendFooter の形） ---

const METRICS_HEADER = [
  '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン（入力/出力/キャッシュ書込/キャッシュ読込） | 推定料金（USD） | セッション |',
  '| --- | --- | --- | --- | --- | --- | --- |',
];

/** render-metrics のコメント本文 */
function metricsComment(row: { at?: string; stage: string; minutes: string; tokens: string; usd: string }): string {
  return [
    claudeMark(),
    ...METRICS_HEADER,
    `| ${row.at ?? '2026-09-20T10:00'} | ${row.stage} | claude-opus-5-5 | ${row.minutes} | ${row.tokens} | ${row.usd} | 手動 |`,
    '',
    'トークン数と推定料金は、このセッションのここまでの累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。',
  ].join('\n');
}

/** PR 本文の末尾の実行メトリクス表（料金の列が無い） */
function bodyWithFooter(rows: { at: string; stage: string; minutes: string; tokens: string }[]): string {
  return [
    'Closes #3',
    '',
    '<!-- agent-harness:metrics -->',
    '### 実行メトリクス',
    '',
    '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン | セッション |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.at} | ${r.stage} | claude-opus-5-5 | ${r.minutes} | ${r.tokens} | 手動 |`),
  ].join('\n');
}

// --- 偽の GitHub の世界 ---

interface PrSpec {
  number: number;
  title?: string;
  /** null は Merge されずに閉じた PR */
  mergedAt: string | null;
  ref?: string;
  /** merged_by の login（既定は App） */
  mergedBy?: string;
  association?: string;
  body?: string;
  files?: string[];
  comments?: IssueComment[];
  reviews?: unknown[];
}

interface Attempt {
  conclusion: string;
  jobs?: { id: number; name: string; conclusion: string }[];
}

interface RunSpec {
  id: number;
  name?: string;
  workflowId?: number;
  headSha: string;
  attempt?: number;
  conclusion: string;
  createdAt: string;
  /** この実行（最後の試行）のジョブ */
  jobs?: { id: number; name: string; conclusion: string }[];
  /** 前の試行（試行番号 → 中身） */
  attempts?: Record<number, Attempt>;
}

interface World {
  prs: PrSpec[];
  commits?: { sha: string; message: string }[];
  /** /commits/{sha}/pulls の応答（PR 番号） */
  commitPulls?: Record<string, number[]>;
  runs?: RunSpec[];
  /** ジョブのログ。無いジョブは 404 */
  logs?: Record<number, string>;
}

const pageOf = (m: RegExpMatchArray): number => Number(m.input?.match(/[?&]page=(\d+)/)?.[1] ?? 1);
/** ページ送りの1ページ目だけに中身を返す */
const firstPage = <T>(m: RegExpMatchArray, items: T[]): T[] => (pageOf(m) === 1 ? items : []);

const runUrl = (id: number): string => `https://github.com/o/r/actions/runs/${id}`;
const attemptUrl = (id: number, attempt: number): string => `https://github.com/o/r/actions/runs/${id}/attempts/${attempt}`;

function retroFake(w: World): FakeGitHub {
  const prOf = (n: string | undefined): PrSpec => {
    const found = w.prs.find((p) => p.number === Number(n));
    if (!found) throw new HttpError(404, `pulls/${n}`);
    return found;
  };
  const runOf = (id: string | undefined): RunSpec => {
    const found = (w.runs ?? []).find((r) => r.id === Number(id));
    if (!found) throw new HttpError(404, `runs/${id}`);
    return found;
  };
  const listItem = (p: PrSpec) => ({
    number: p.number, title: p.title ?? `feat: #${p.number}`, state: 'closed', draft: false, html_url: `https://github.com/o/r/pull/${p.number}`,
    merged_at: p.mergedAt, closed_at: p.mergedAt ?? sep(20), updated_at: p.mergedAt ?? sep(20), created_at: sep(1),
    user: { login: 'me', type: 'User' }, author_association: p.association ?? 'OWNER', body: p.body ?? 'Closes #3', labels: [],
    head: { ref: p.ref ?? `claude/issue-${p.number}-x`, sha: 'a'.repeat(40), repo: { full_name: 'o/r' } }, base: { ref: 'main', sha: 'b'.repeat(40) },
  });
  const runItem = (r: RunSpec) => ({
    id: r.id, name: r.name ?? 'ci', workflow_id: r.workflowId ?? 1, head_sha: r.headSha, run_attempt: r.attempt ?? 1, status: 'completed',
    conclusion: r.conclusion, html_url: runUrl(r.id), created_at: r.createdAt,
  });
  return new FakeGitHub()
    .on('GET', /\/pulls\?state=closed/, (m) => firstPage(m, w.prs.map(listItem)))
    .on('GET', /\/pulls\/(\d+)$/, (m) => {
      const p = prOf(m[1]);
      return { ...listItem(p), merged: p.mergedAt !== null, merged_by: p.mergedAt ? { login: p.mergedBy ?? APP, type: 'Bot' } : null };
    })
    .on('GET', /\/pulls\/(\d+)\/files/, (m) => firstPage(m, (prOf(m[1]).files ?? ['docs/a.md']).map((filename) => ({ filename, status: 'modified', additions: 1, deletions: 1 }))))
    .on('GET', /\/pulls\/(\d+)\/reviews/, (m) => firstPage(m, prOf(m[1]).reviews ?? []))
    .on('GET', /\/issues\/(\d+)\/comments/, (m) => firstPage(m, w.prs.find((p) => p.number === Number(m[1]))?.comments ?? []))
    .on('GET', /\/commits\?/, (m) => firstPage(m, (w.commits ?? []).map((c) => ({ sha: c.sha, commit: { message: c.message } }))))
    .on('GET', /\/commits\/([0-9a-f]+)\/pulls/, (m) => (w.commitPulls?.[m[1]!] ?? []).map((number) => ({ number })))
    .on('GET', /\/actions\/workflows(\?[^/]*)?$/, () => {
      const ids = [...new Set((w.runs ?? []).map((r) => r.workflowId ?? 1))];
      return { total_count: ids.length, workflows: ids.map((id) => ({ id, name: (w.runs ?? []).find((r) => (r.workflowId ?? 1) === id)?.name ?? 'ci', path: `.github/workflows/${id}.yml` })) };
    })
    .on('GET', /\/actions\/workflows\/(\d+)\/runs\?/, (m) => {
      const runs = (w.runs ?? []).filter((r) => (r.workflowId ?? 1) === Number(m[1])).map(runItem);
      return { total_count: runs.length, workflow_runs: firstPage(m, runs) };
    })
    .on('GET', /\/actions\/runs\/(\d+)\/attempts\/(\d+)(\?[^/]*)?$/, (m) => {
      const r = runOf(m[1]);
      const n = Number(m[2]);
      if (n === (r.attempt ?? 1)) return runItem(r);
      const a = r.attempts?.[n];
      if (!a) throw new HttpError(404, `runs/${r.id}/attempts/${n}`);
      return { ...runItem(r), run_attempt: n, conclusion: a.conclusion, html_url: attemptUrl(r.id, n) };
    })
    .on('GET', /\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/, (m) => {
      const r = runOf(m[1]);
      const n = Number(m[2]);
      const jobs = n === (r.attempt ?? 1) ? (r.jobs ?? []) : (r.attempts?.[n]?.jobs ?? []);
      return { total_count: jobs.length, jobs: firstPage(m, jobs) };
    })
    .on('GET', /\/actions\/runs\/(\d+)\/jobs/, (m) => {
      const jobs = runOf(m[1]).jobs ?? [];
      return { total_count: jobs.length, jobs: firstPage(m, jobs) };
    })
    .on('GET', /\/actions\/jobs\/(\d+)\/logs/, (m, _body, opts: RequestOptions) => {
      const log = w.logs?.[Number(m[1])];
      if (log !== undefined) return log;
      if (opts.allow404) return null;
      throw new HttpError(404, `jobs/${m[1]}/logs -> 404`);
    });
}

async function collect(w: World): Promise<{ data: QaRetroData; fake: FakeGitHub }> {
  const fake = retroFake(w);
  const data = await collectQaRetro(new GitHub(fake, 'o/r'), config, PERIOD);
  return { data, fake };
}

const prIn = (data: QaRetroData, n: number): QaRetroPr => {
  const found = data.prs.find((p) => p.number === n);
  assert.ok(found, `#${n} が prs にありません`);
  return found;
};

// --- parseQaRetroArgs ---

const NOW = new Date('2026-09-29T08:30:00Z');

test('parseQaRetroArgs：引数が無ければ今から14日前までを見る', () => {
  const r = parseQaRetroArgs([], NOW);
  assert.ok(r.ok);
  assert.equal(r.value.until.toISOString(), NOW.toISOString());
  assert.equal(r.value.since.toISOString(), '2026-09-15T08:30:00.000Z');
});

test('parseQaRetroArgs：--days で日数を変える', () => {
  const r = parseQaRetroArgs(['--days', '7'], NOW);
  assert.ok(r.ok);
  assert.equal(r.value.until.toISOString(), NOW.toISOString());
  assert.equal(r.value.since.toISOString(), '2026-09-22T08:30:00.000Z');
});

test('parseQaRetroArgs：--since はその日の 00:00Z、--until はその日を含む（翌日の 00:00Z）', () => {
  const r = parseQaRetroArgs(['--since', '2026-09-01', '--until', '2026-09-10'], NOW);
  assert.ok(r.ok);
  assert.equal(r.value.since.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(r.value.until.toISOString(), '2026-09-11T00:00:00.000Z');
});

test('parseQaRetroArgs：--since だけなら終わりは今', () => {
  const r = parseQaRetroArgs(['--since', '2026-09-20'], NOW);
  assert.ok(r.ok);
  assert.equal(r.value.since.toISOString(), '2026-09-20T00:00:00.000Z');
  assert.equal(r.value.until.toISOString(), NOW.toISOString());
});

test('parseQaRetroArgs：--since と --days は同時に渡せない', () => {
  const r = parseQaRetroArgs(['--since', '2026-09-01', '--days', '3'], NOW);
  assert.equal(r.ok, false);
});

test('parseQaRetroArgs：形式の誤りはエラー', () => {
  for (const args of [['--days', '0'], ['--days', '-1'], ['--days', '1.5'], ['--days', 'x'], ['--days'], ['--since', '2026/09/01'], ['--until', '09-10']]) {
    const r = parseQaRetroArgs(args, NOW);
    assert.equal(r.ok, false, `${args.join(' ')} を受け付けました`);
    if (!r.ok) assert.ok(r.errors.length > 0);
  }
});

test('parseQaRetroArgs：始まりが終わり以降ならエラー', () => {
  assert.equal(parseQaRetroArgs(['--since', '2026-09-10', '--until', '2026-09-01'], NOW).ok, false);
  assert.equal(parseQaRetroArgs(['--since', '2026-09-30'], NOW).ok, false);
});

// --- mergeRouteOf ---

test('mergeRouteOf：App が Merge し、委任の記録が無ければ auto', () => {
  assert.equal(mergeRouteOf(config, { login: APP }, [acceptanceComment()]), 'auto');
});

test('mergeRouteOf：App が Merge し、App の delegated-merge の記録があれば delegated', () => {
  assert.equal(mergeRouteOf(config, { login: APP }, [acceptanceComment(), delegatedMergeComment()]), 'delegated');
});

test('mergeRouteOf：App 以外の名義の delegated-merge の記録は委任とみなさない', () => {
  assert.equal(mergeRouteOf(config, { login: APP }, [delegatedMergeComment('me')]), 'auto');
});

test('mergeRouteOf：人が Merge したら human（委任の記録があっても）', () => {
  assert.equal(mergeRouteOf(config, { login: 'me' }, [delegatedMergeComment()]), 'human');
  assert.equal(mergeRouteOf(config, null, []), 'human');
});

// --- collectQaRetro：対象の PR と Merge の経路 ---

test('collectQaRetro：期間内に Merge された PR だけを対象にする', async () => {
  const { data } = await collect({
    prs: [
      { number: 1, mergedAt: sep(20) },
      { number: 2, mergedAt: sep(14, 23) },
      { number: 3, mergedAt: null },
      { number: 4, mergedAt: '2026-09-29T00:00:00Z' },
      { number: 5, mergedAt: '2026-09-15T00:00:00Z' },
    ],
  });
  assert.deepEqual(data.prs.map((p) => p.number).sort((a, b) => a - b), [1, 5]);
  assert.equal(data.period.since, SINCE.toISOString());
  assert.equal(data.period.until, UNTIL.toISOString());
});

test('collectQaRetro：PR ごとの Merge の経路を merged_by と委任の記録から決める', async () => {
  const { data } = await collect({
    prs: [
      { number: 1, mergedAt: sep(20), comments: [acceptanceComment()] },
      { number: 2, mergedAt: sep(20), comments: [acceptanceComment({ autoEligible: false }), delegatedMergeComment()] },
      { number: 3, mergedAt: sep(20), mergedBy: 'me', comments: [acceptanceComment({ riskLevel: 'critical', autoEligible: false })] },
    ],
  });
  assert.equal(prIn(data, 1).mergeRoute, 'auto');
  assert.equal(prIn(data, 2).mergeRoute, 'delegated');
  assert.equal(prIn(data, 3).mergeRoute, 'human');
});

test('collectQaRetro：claude/ ブランチの PR を Agent PR とする', async () => {
  const { data } = await collect({
    prs: [
      { number: 1, mergedAt: sep(20) },
      { number: 2, mergedAt: sep(20), ref: 'feature/x', mergedBy: 'me' },
    ],
  });
  assert.equal(prIn(data, 1).agentPr, true);
  assert.equal(prIn(data, 2).agentPr, false);
});

// --- collectQaRetro：risk と判定の回数 ---

test('collectQaRetro：risk は最後の受け付けの記録の riskLevel、判定の回数は受け付けの記録の数', async () => {
  const { data } = await collect({
    prs: [{
      number: 1, mergedAt: sep(20),
      comments: [
        acceptanceComment({ riskLevel: 'medium', autoEligible: false }),
        comment('判定のやり直しをお願いします'),
        acceptanceComment({ riskLevel: 'low', autoEligible: true }),
        // App 以外の名義の受け付けの記録は数えない
        appComment('acceptance', acceptance({ riskLevel: 'critical' }), 'me'),
      ],
    }],
  });
  const p = prIn(data, 1);
  assert.equal(p.risk, 'low');
  assert.equal(p.autoEligible, true);
  assert.equal(p.verdicts, 2);
});

test('collectQaRetro：受け付けの記録が無い PR は risk も autoEligible も null で、判定の回数は 0', async () => {
  const { data } = await collect({ prs: [{ number: 1, mergedAt: sep(20), mergedBy: 'me' }] });
  const p = prIn(data, 1);
  assert.equal(p.risk, null);
  assert.equal(p.autoEligible, null);
  assert.equal(p.verdicts, 0);
  assert.equal(p.rejectedVerdicts, 0);
  assert.equal(p.fixRequests, 0);
});

test('collectQaRetro：受け付けられなかった判定（App の verdict-rejected）を数える', async () => {
  const { data } = await collect({
    prs: [{
      number: 1, mergedAt: sep(20),
      comments: [
        appComment('verdict-rejected', { version: 1, reasons: ['書式'] }),
        appComment('verdict-rejected', { version: 1, reasons: ['head が違う'] }),
        appComment('verdict-rejected', { version: 1, reasons: ['偽物'] }, 'me'),
        acceptanceComment(),
      ],
    }],
  });
  assert.equal(prIn(data, 1).rejectedVerdicts, 2);
});

test('collectQaRetro：修正の往復は App の fix-request のレビューだけを数える', async () => {
  const { data } = await collect({
    prs: [{
      number: 1, mergedAt: sep(20), comments: [acceptanceComment()],
      reviews: [
        fixRequestReview(),
        fixRequestReview(),
        fixRequestReview('me'),
        { id: 9999, state: 'APPROVED', submitted_at: sep(21), commit_id: 'a'.repeat(40), body: 'LGTM', html_url: 'r', author_association: 'OWNER', user: { login: 'me', type: 'User' } },
      ],
    }],
  });
  assert.equal(prIn(data, 1).fixRequests, 2);
});

// --- collectQaRetro：後追いの修正 ---

test('collectQaRetro：Merge 後 7 日以内に同じファイルを変えた fix の PR が組になる', async () => {
  const { data } = await collect({
    prs: [
      { number: 10, mergedAt: sep(18), files: ['src/a.ts', 'docs/a.md'], comments: [acceptanceComment({ riskLevel: 'medium' })] },
      { number: 11, title: 'fix: a を直す', mergedAt: sep(20), files: ['src/a.ts'] },
    ],
  });
  assert.deepEqual(prIn(data, 10).fixedBy, [11]);
  const followup = data.followups.find((f) => f.pr === 10);
  assert.ok(followup, '#10 が followups にありません');
  assert.equal(followup.risk, 'medium');
  assert.equal(followup.mergeRoute, 'auto');
  assert.equal(followup.reverted, false);
  assert.deepEqual(followup.fixes.map((f) => f.number), [11]);
  assert.equal(followup.fixes[0]!.title, 'fix: a を直す');
  assert.ok(followup.fixes[0]!.files.includes('src/a.ts'));
});

test('collectQaRetro：ファイルが重ならない fix の PR は組にならない', async () => {
  const { data } = await collect({
    prs: [
      { number: 10, mergedAt: sep(18), files: ['src/a.ts'] },
      { number: 11, title: 'fix: b を直す', mergedAt: sep(20), files: ['src/b.ts'] },
    ],
  });
  assert.deepEqual(prIn(data, 10).fixedBy, []);
  assert.equal(data.followups.some((f) => f.pr === 10), false);
});

test('collectQaRetro：Merge から 7 日より後の fix の PR は組にならない', async () => {
  const { data } = await collect({
    prs: [
      { number: 10, mergedAt: sep(16), files: ['src/a.ts'] },
      { number: 11, title: 'fix: a を直す', mergedAt: sep(23, 13), files: ['src/a.ts'] },
    ],
  });
  assert.deepEqual(prIn(data, 10).fixedBy, []);
});

test('collectQaRetro：fix でない PR は同じファイルを変えても組にならない', async () => {
  const { data } = await collect({
    prs: [
      { number: 10, mergedAt: sep(18), files: ['src/a.ts'] },
      { number: 11, title: 'docs: a の説明', ref: 'claude/issue-11-docs', mergedAt: sep(20), files: ['src/a.ts'] },
    ],
  });
  assert.deepEqual(prIn(data, 10).fixedBy, []);
});

test('collectQaRetro：期間の終わりの後（7 日以内）に Merge された fix の PR も拾うが、その PR 自体は対象にしない', async () => {
  const { data } = await collect({
    prs: [
      { number: 10, mergedAt: sep(27), files: ['src/a.ts'] },
      { number: 11, title: 'fix: a を直す', mergedAt: '2026-10-01T12:00:00Z', files: ['src/a.ts'] },
    ],
  });
  assert.deepEqual(prIn(data, 10).fixedBy, [11]);
  assert.equal(data.prs.some((p) => p.number === 11), false);
});

// --- collectQaRetro：revert ---

const REVERTED_SHA = '0123456789abcdef0123456789abcdef01234567';

test('collectQaRetro：Reverts owner/repo#N のコミットで revert されたとみなす', async () => {
  const { data } = await collect({
    prs: [
      { number: 20, mergedAt: sep(18), comments: [acceptanceComment({ riskLevel: 'medium', autoEligible: false })], mergedBy: 'me' },
      { number: 22, mergedAt: sep(18) },
    ],
    commits: [{ sha: 'c'.repeat(40), message: 'Revert "feat: #20" (#30)\n\nReverts o/r#20' }],
  });
  assert.equal(prIn(data, 20).reverted, true);
  assert.equal(prIn(data, 22).reverted, false);
  const followup = data.followups.find((f) => f.pr === 20);
  assert.ok(followup, '#20 が followups にありません');
  assert.equal(followup.reverted, true);
  assert.equal(followup.risk, 'medium');
  assert.equal(followup.mergeRoute, 'human');
  assert.deepEqual(followup.fixes, []);
  assert.equal(data.followups.some((f) => f.pr === 22), false);
});

test('collectQaRetro：This reverts commit <sha> は /commits/{sha}/pulls で PR に戻して revert とみなす', async () => {
  const { data, fake } = await collect({
    prs: [{ number: 21, mergedAt: sep(19), comments: [acceptanceComment({ riskLevel: 'low' })] }],
    commits: [{ sha: 'd'.repeat(40), message: `Revert "feat: #21"\n\nThis reverts commit ${REVERTED_SHA}.` }],
    commitPulls: { [REVERTED_SHA]: [21] },
  });
  assert.ok(fake.calls.some((c) => c.path.includes(`/commits/${REVERTED_SHA}/pulls`)), '/commits/{sha}/pulls を呼んでいません');
  assert.equal(prIn(data, 21).reverted, true);
  const followup = data.followups.find((f) => f.pr === 21);
  assert.ok(followup, '#21 が followups にありません');
  assert.equal(followup.reverted, true);
  assert.equal(followup.risk, 'low');
});

test('collectQaRetro：revert を探すコミットは期間の始まりから終わりの 7 日後までを読む', async () => {
  const { fake } = await collect({ prs: [{ number: 1, mergedAt: sep(20) }] });
  const call = fake.calls.find((c) => /\/commits\?/.test(c.path));
  assert.ok(call, '/commits を呼んでいません');
  const path = decodeURIComponent(call.path);
  assert.match(path, /since=2026-09-15T00:00:00/);
  assert.match(path, /until=2026-10-06T00:00:00/);
});

// --- collectQaRetro：CI の再実行 ---

const LOG_1001 = [
  '2026-09-20T10:00:00.1234567Z ▶ 受け付け',
  '2026-09-20T10:00:00.2234567Z not ok 3 - 受け付けの記録を読む',
  '2026-09-20T10:00:00.3234567Z \u001b[31m✖ 受け付けの記録を読む (12.3ms)\u001b[39m',
  '2026-09-20T10:00:00.4234567Z ok 4 - 通るテスト',
].join('\n');

/** 再実行（run_attempt 2）で通った実行・別の実行で通った組・数えない実行を並べた世界 */
function ciWorld(): World {
  return {
    prs: [],
    runs: [
      // 再実行で通った：試行 1 が失敗（ci と gate が失敗）、試行 2 が成功
      {
        id: 100, headSha: '1'.repeat(40), attempt: 2, conclusion: 'success', createdAt: sep(20, 10),
        jobs: [{ id: 1101, name: 'ci', conclusion: 'success' }],
        attempts: { 1: { conclusion: 'failure', jobs: [{ id: 1001, name: 'ci', conclusion: 'failure' }, { id: 1002, name: 'gate', conclusion: 'failure' }] } },
      },
      // 同じ workflow・head の別の実行が失敗 → 成功（失敗したジョブのログは 404）
      { id: 200, headSha: '2'.repeat(40), conclusion: 'failure', createdAt: sep(21, 10), jobs: [{ id: 2001, name: 'ci', conclusion: 'failure' }] },
      { id: 201, headSha: '2'.repeat(40), conclusion: 'success', createdAt: sep(21, 11), jobs: [{ id: 2101, name: 'ci', conclusion: 'success' }] },
      // 再実行したが前の試行も成功だった：数えない
      {
        id: 300, headSha: '3'.repeat(40), attempt: 2, conclusion: 'success', createdAt: sep(22, 10),
        jobs: [{ id: 3101, name: 'ci', conclusion: 'success' }], attempts: { 1: { conclusion: 'success', jobs: [{ id: 3001, name: 'ci', conclusion: 'success' }] } },
      },
      // head が違う失敗と成功：数えない
      { id: 400, headSha: '4'.repeat(40), conclusion: 'failure', createdAt: sep(23, 10), jobs: [{ id: 4001, name: 'ci', conclusion: 'failure' }] },
      { id: 401, headSha: '5'.repeat(40), conclusion: 'success', createdAt: sep(23, 11) },
      // 成功の後に失敗：数えない
      { id: 500, headSha: '6'.repeat(40), conclusion: 'success', createdAt: sep(24, 10) },
      { id: 501, headSha: '6'.repeat(40), conclusion: 'failure', createdAt: sep(24, 11), jobs: [{ id: 5001, name: 'ci', conclusion: 'failure' }] },
      // workflow が違う失敗と成功：数えない
      { id: 600, workflowId: 1, headSha: '7'.repeat(40), conclusion: 'failure', createdAt: sep(25, 10), jobs: [{ id: 6001, name: 'ci', conclusion: 'failure' }] },
      { id: 601, workflowId: 2, name: 'gate', headSha: '7'.repeat(40), conclusion: 'success', createdAt: sep(25, 11) },
    ],
    logs: { 1001: LOG_1001 },
  };
}

test('collectQaRetro：再実行（run_attempt 2）で通り、前の試行が失敗した実行を flakyCi に出す', async () => {
  const { data } = await collect(ciWorld());
  const rerun = data.flakyCi.find((f) => f.kind === 'rerun');
  assert.ok(rerun, 'rerun がありません');
  assert.equal(rerun.workflow, 'ci');
  assert.equal(rerun.headSha, '1'.repeat(40));
  assert.deepEqual(rerun.failed, { runId: 100, attempt: 1, url: attemptUrl(100, 1) });
  assert.deepEqual(rerun.passed, { runId: 100, attempt: 2, url: runUrl(100) });
});

test('collectQaRetro：失敗したジョブのログから失敗したテストの名前を読む', async () => {
  const { data } = await collect(ciWorld());
  const rerun = data.flakyCi.find((f) => f.kind === 'rerun');
  assert.ok(rerun, 'rerun がありません');
  assert.deepEqual(rerun.jobs, [{ name: 'ci', id: 1001, testNames: ['受け付けの記録を読む'] }]);
});

test('collectQaRetro：projectChecks に無いジョブ（gate）は数えず、ログも読まない', async () => {
  const { data, fake } = await collect(ciWorld());
  const names = data.flakyCi.flatMap((f) => f.jobs.map((j) => j.name));
  assert.equal(names.includes('gate'), false);
  assert.equal(fake.calls.some((c) => c.path.includes('/actions/jobs/1002/logs')), false);
});

test('collectQaRetro：同じ workflow・head の別の実行が失敗の後に通った組を flakyCi に出す', async () => {
  const { data } = await collect(ciWorld());
  const separate = data.flakyCi.filter((f) => f.kind === 'separate-run');
  assert.equal(separate.length, 1, JSON.stringify(separate));
  const s = separate[0]!;
  assert.equal(s.headSha, '2'.repeat(40));
  assert.deepEqual(s.failed, { runId: 200, attempt: 1, url: runUrl(200) });
  assert.deepEqual(s.passed, { runId: 201, attempt: 1, url: runUrl(201) });
});

test('collectQaRetro：ジョブのログが 404 なら testNames を null にして続け、読めなかった数を残す', async () => {
  const { data } = await collect(ciWorld());
  const s = data.flakyCi.find((f) => f.kind === 'separate-run');
  assert.ok(s, 'separate-run がありません');
  assert.deepEqual(s.jobs, [{ name: 'ci', id: 2001, testNames: null }]);
  assert.equal(data.notes.unreadableLogs, 1);
});

test('collectQaRetro：前の試行も成功・head が違う・成功の後の失敗・workflow が違うものは flakyCi に出さない', async () => {
  const { data } = await collect(ciWorld());
  assert.equal(data.flakyCi.length, 2, JSON.stringify(data.flakyCi));
  const shas = data.flakyCi.map((f) => f.headSha);
  for (const c of ['3', '4', '5', '6', '7']) assert.equal(shas.includes(c.repeat(40)), false, `${c.repeat(7)}… が flakyCi に出ています`);
});

// --- parseFailedTestNames ---

test('parseFailedTestNames：タイムスタンプと色を除き、not ok と ✖ のテスト名を重複なく出た順に読む', () => {
  const log = [
    '2026-09-29T10:00:00.1234567Z ▶ suite',
    '2026-09-29T10:00:00.1234567Z not ok 3 - 受け付けの記録を読む # TODO',
    '2026-09-29T10:00:00.1234567Z \u001b[31m✖ 受け付けの記録を読む (12.3ms)\u001b[39m',
    '2026-09-29T10:00:00.1234567Z \u001b[31m✖ failing tests:\u001b[39m',
    '2026-09-29T10:00:00.1234567Z \u001b[31m✖ 期限を数える (1.5ms)\u001b[39m',
    '2026-09-29T10:00:00.1234567Z ok 4 - 通るテスト',
    '2026-09-29T10:00:00.1234567Z not ok 5 - 期限を数える',
  ].join('\n');
  assert.deepEqual(parseFailedTestNames(log), ['受け付けの記録を読む', '期限を数える']);
});

test('parseFailedTestNames：失敗が無ければ空', () => {
  assert.deepEqual(parseFailedTestNames('2026-09-29T10:00:00.1234567Z ok 1 - 通る\n2026-09-29T10:00:00.1234567Z # pass 1'), []);
});

// --- parseMetricsTables・sumMetrics ---

test('parseMetricsTables：render-metrics のコメントの表を読む', () => {
  const rows = parseMetricsTables(metricsComment({ stage: 'implement', minutes: '12', tokens: '1,000 / 200 / 30 / 4,000', usd: '$1.25' }), 'comment');
  assert.deepEqual(rows, [{
    source: 'comment', at: '2026-09-20T10:00', stage: 'implement', model: 'claude-opus-5-5', minutes: 12,
    tokens: { input: 1000, output: 200, cacheWrite: 30, cacheRead: 4000 }, totalTokens: 5230, usd: 1.25,
  }]);
});

test('parseMetricsTables：PR 本文の表はトークンが1つの数で、料金の列が無い', () => {
  const rows = parseMetricsTables(bodyWithFooter([
    { at: '2026-09-20T09:00', stage: 'plan', minutes: '20', tokens: '123,456' },
    { at: '2026-09-20T11:00', stage: 'implement', minutes: '7.5', tokens: 'unknown' },
  ]), 'body');
  assert.deepEqual(rows, [
    { source: 'body', at: '2026-09-20T09:00', stage: 'plan', model: 'claude-opus-5-5', minutes: 20, tokens: null, totalTokens: 123456, usd: null },
    { source: 'body', at: '2026-09-20T11:00', stage: 'implement', model: 'claude-opus-5-5', minutes: 7.5, tokens: null, totalTokens: null, usd: null },
  ]);
});

test('parseMetricsTables：unknown・不明・数でない値は null', () => {
  const [unknown] = parseMetricsTables(metricsComment({ stage: 'judge', minutes: '?', tokens: 'unknown', usd: 'unknown' }), 'comment');
  assert.ok(unknown);
  assert.equal(unknown.minutes, null);
  assert.equal(unknown.tokens, null);
  assert.equal(unknown.totalTokens, null);
  assert.equal(unknown.usd, null);
  const [noPrice] = parseMetricsTables(metricsComment({ stage: 'judge', minutes: '3', tokens: '1 / 2 / 3 / 4', usd: '不明' }), 'comment');
  assert.ok(noPrice);
  assert.equal(noPrice.usd, null);
  assert.equal(noPrice.totalTokens, 10);
});

test('parseMetricsTables：段階と所要時間の列を持たない表は読まない', () => {
  const text = ['| ファイル | 変更 |', '| --- | --- |', '| a.ts | 12 |', '', '| 段階 | 結果 |', '| --- | --- |', '| plan | ok |'].join('\n');
  assert.deepEqual(parseMetricsTables(text, 'comment'), []);
});

const row = (patch: Partial<MetricRow>): MetricRow => ({
  source: 'comment', at: '2026-09-20T10:00', stage: 'implement', model: 'm', minutes: 1,
  tokens: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 }, totalTokens: 2, usd: 0.5, ...patch,
});

test('sumMetrics：読めた値だけを合計し、読めなかった値の数を unreadable に数える', () => {
  const rows = [
    row({ minutes: 10, tokens: { input: 100, output: 20, cacheWrite: 3, cacheRead: 400 }, totalTokens: 523, usd: 1.5 }),
    row({ minutes: null, tokens: null, totalTokens: null, usd: null }),
    row({ source: 'body', minutes: 5, tokens: null, totalTokens: 1000, usd: null }),
  ];
  const s = sumMetrics(rows);
  assert.equal(s.rows, rows);
  assert.equal(s.minutes, 15);
  assert.deepEqual(s.tokens, { input: 100, output: 20, cacheWrite: 3, cacheRead: 400 });
  assert.equal(s.totalTokens, 1523);
  assert.equal(s.usd, 1.5);
  // 2行目の所要時間・トークン・料金で 3。本文の表（3行目）の料金は列が無いので数えない
  assert.equal(s.unreadable, 3);
});

test('sumMetrics：行が無ければすべて 0', () => {
  assert.deepEqual(sumMetrics([]), {
    rows: [], minutes: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, totalTokens: 0, usd: 0, unreadable: 0,
  });
});

test('collectQaRetro：コラボレーターのメトリクスのコメントと PR 本文の表を合計する', async () => {
  const { data } = await collect({
    prs: [{
      number: 1, mergedAt: sep(20),
      body: bodyWithFooter([{ at: '2026-09-20T09:00', stage: 'plan', minutes: '20', tokens: '123,456' }]),
      comments: [
        comment(metricsComment({ stage: 'implement', minutes: '12', tokens: '1,000 / 200 / 30 / 4,000', usd: '$1.25' }), 'OWNER'),
        comment(metricsComment({ stage: 'judge', minutes: '5', tokens: 'unknown', usd: 'unknown' }), 'COLLABORATOR'),
        // コラボレーター以外の表は読まない
        comment(metricsComment({ stage: 'fix', minutes: '999', tokens: '9 / 9 / 9 / 9', usd: '$99.00' }), 'NONE'),
        comment(metricsComment({ stage: 'fix', minutes: '999', tokens: '9 / 9 / 9 / 9', usd: '$99.00' }), 'CONTRIBUTOR'),
      ],
    }],
  });
  const m = prIn(data, 1).metrics;
  assert.equal(m.rows.length, 3);
  assert.equal(m.minutes, 37);
  assert.deepEqual(m.tokens, { input: 1000, output: 200, cacheWrite: 30, cacheRead: 4000 });
  assert.equal(m.totalTokens, 5230 + 123456);
  assert.equal(m.usd, 1.25);
  // judge の行のトークンと料金
  assert.equal(m.unreadable, 2);
  assert.equal(data.notes.unreadableMetrics, 2);
});

test('collectQaRetro：作成者がコラボレーターでない PR の本文の表は読まない', async () => {
  const { data } = await collect({
    prs: [{ number: 1, mergedAt: sep(20), association: 'CONTRIBUTOR', body: bodyWithFooter([{ at: '2026-09-20T09:00', stage: 'plan', minutes: '20', tokens: '123,456' }]) }],
  });
  const m = prIn(data, 1).metrics;
  assert.equal(m.rows.length, 0);
  assert.equal(m.minutes, 0);
  assert.equal(m.totalTokens, 0);
});

// --- summarizeQaRetro ---

function retroPr(patch: Partial<QaRetroPr>): QaRetroPr {
  return {
    number: 1, title: 't', mergedAt: sep(20), agentPr: true, risk: 'low', autoEligible: true, mergeRoute: 'auto', verdicts: 1, rejectedVerdicts: 0, fixRequests: 0,
    metrics: sumMetrics([]), fixedBy: [], reverted: false, ...patch,
  };
}

test('summarizeQaRetro：risk ごとの Merge 数・後追い修正・revert の数と割合', () => {
  const by = summarizeQaRetro([
    retroPr({ number: 1, risk: 'low', mergeRoute: 'auto', fixedBy: [9] }),
    retroPr({ number: 2, risk: 'low', mergeRoute: 'auto' }),
    retroPr({ number: 3, risk: 'low', mergeRoute: 'human', reverted: true }),
    retroPr({ number: 4, risk: 'medium', mergeRoute: 'human', fixedBy: [8, 7], reverted: true }),
  ]);
  assert.deepEqual({ ...by.low, auto: undefined }, { merged: 3, fixed: 1, reverted: 1, fixedRate: 1 / 3, revertedRate: 1 / 3, auto: undefined });
  assert.deepEqual({ ...by.medium, auto: undefined }, { merged: 1, fixed: 1, reverted: 1, fixedRate: 1, revertedRate: 1, auto: undefined });
});

test('summarizeQaRetro：auto は自動 Merge（委任を含む）だけを数える', () => {
  const by = summarizeQaRetro([
    retroPr({ number: 1, risk: 'low', mergeRoute: 'auto', fixedBy: [9] }),
    retroPr({ number: 2, risk: 'low', mergeRoute: 'delegated' }),
    retroPr({ number: 3, risk: 'low', mergeRoute: 'human', reverted: true }),
  ]);
  assert.deepEqual(by.low.auto, { merged: 2, fixed: 1, reverted: 0, fixedRate: 0.5, revertedRate: 0 });
});

test('summarizeQaRetro：risk が無い・知らない値は none にまとめ、Merge が 0 の risk の割合は null', () => {
  const by = summarizeQaRetro([
    retroPr({ number: 1, risk: null, autoEligible: null, mergeRoute: 'human' }),
    retroPr({ number: 2, risk: 'unknown', mergeRoute: 'human', fixedBy: [5] }),
  ]);
  assert.equal(by.none.merged, 2);
  assert.equal(by.none.fixed, 1);
  assert.equal(by.none.fixedRate, 0.5);
  for (const key of ['low', 'medium', 'high', 'critical'] as const) {
    assert.deepEqual(by[key], {
      merged: 0, fixed: 0, reverted: 0, fixedRate: null, revertedRate: null,
      auto: { merged: 0, fixed: 0, reverted: 0, fixedRate: null, revertedRate: null },
    }, key);
  }
});

test('collectQaRetro：byRisk は対象の PR を summarizeQaRetro でまとめたもの', async () => {
  const { data } = await collect({
    prs: [
      { number: 1, mergedAt: sep(20), comments: [acceptanceComment({ riskLevel: 'low' })] },
      { number: 2, mergedAt: sep(20), mergedBy: 'me', comments: [acceptanceComment({ riskLevel: 'high', autoEligible: false })] },
    ],
  });
  assert.deepEqual(data.byRisk, summarizeQaRetro(data.prs));
  assert.equal(data.byRisk.low.auto.merged, 1);
  assert.equal(data.byRisk.high.merged, 1);
  assert.equal(data.byRisk.high.auto.merged, 0);
});
