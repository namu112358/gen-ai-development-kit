// review-api のレビューの材料集め（review-api/src/collect.ts の collectMaterial）が、偽の fetch に対して、PR 本文の Closes の Issue と
// その plan-gate 記録の計画（App 以外の名義・目印の無いコメント・フェンスが壊れたコメントは読まず、最新の記録の plan を読む）、
// Closes が無い・2つなら issue と plan が null、最後の記録に plan が無ければ plan が null、diff とファイルの上限（maxDiffChars・maxFileChars）、
// 削除したファイルを読まないこと、前回の shadow 記録（reviewLogin の名義で head が違う最後のもの。Issue #911）を読むこと、collect.ts が cloudflare:workers・
// @anthropic-ai/sdk・node:・harness/lib を import しないことを、外部 API を呼ばずに確かめる（Issue #898）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collectMaterial } from '../../review-api/src/collect.ts';
import type { ReviewConfig } from '../../review-api/src/config.ts';
import { createGitHubClient } from '../../review-api/src/github.ts';
import { renderShadowComment, type ShadowRecord } from '../../review-api/src/record.ts';
import { composeShadowVerdict, RISK_QUESTIONS, type Noul, type RiskQuestionKey } from '../../review-api/src/verdict.ts';

const APP = 'agent-harness[bot]';
const REVIEWER = 'review-api[bot]';
const HEAD = 'a'.repeat(40);
const OLD1 = 'b'.repeat(40);
const OLD2 = 'c'.repeat(40);
const config: Pick<ReviewConfig, 'claude'> = {
  claude: { reviewModel: 'm', riskModel: 'm', effort: 'high', maxTokens: 1000, maxToolCalls: 10, maxDiffChars: 200, maxFileChars: 10 },
};

const comment = (id: number, login: string, body: string) => ({ id, body, user: { login }, author_association: 'NONE' });
const appRecord = (value: unknown, kind = 'plan-gate') =>
  `<!-- agent-harness:app kind=${kind} -->\n計画ゲートの記録\n\n\`\`\`agent-app\n${JSON.stringify(value)}\n\`\`\`\n`;

const shadow = (headSha: string): ShadowRecord => ({
  version: 1, pr: 5, headSha,
  verdict: composeShadowVerdict({
    pr: 5,
    headSha,
    reviewer: { pass: true, blocking: [], nonBlocking: [] },
    risk: {
      level: 'low',
      answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, 'no'])) as Record<RiskQuestionKey, Noul>,
      rationale: 'r',
      facts: { references: '', tests: '', fileKinds: '' },
    },
    model: 'm',
  }),
  models: { review: 'm', risk: 'm' }, usage: {}, usd: null, durationSec: 1,
});

// 共有の fixture：Closes #7 の PR #5、Issue #7 のコメント（読むのは2件目の App の記録だけ）、上限を超える diff、ファイルの中身、PR のコメント
const ISSUE_COMMENTS = [
  comment(1, APP, appRecord({ status: 'ok', plan: { v: 'old' } })),
  comment(2, APP, appRecord({ status: 'ok', plan: { v: 'new' } })),
  comment(3, 'someone', appRecord({ status: 'ok', plan: { v: 'stranger' } })),
  comment(4, APP, `目印なし\n\n\`\`\`agent-app\n${JSON.stringify({ plan: { v: 'unmarked' } })}\n\`\`\`\n`),
  comment(5, APP, '<!-- agent-harness:app kind=plan-gate -->\n\n```agent-app\n{ "plan": { "v": "broken"\n```\n'),
];
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1,2 @@',
  '-old',
  `+${'x'.repeat(150)}`,
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1 @@',
  '+short',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');
const FILES: Record<string, string> = { 'src/a.ts': 'A'.repeat(25), 'src/new.ts': 'short', 'src/gone.ts': 'bye' };
const PR_COMMENTS = [shadow(OLD1), shadow(OLD2), shadow(HEAD)].map((r, i) => comment(10 + i, REVIEWER, renderShadowComment(r)));

// URL で振り分ける偽の fetch を createGitHubClient に渡して collectMaterial を呼び、呼ばれた URL も返す
const collect = async (opts: { prBody?: string; issueComments?: ReturnType<typeof comment>[]; prComments?: ReturnType<typeof comment>[] } = {}) => {
  const calls: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url.pathname + url.search);
    const p = url.pathname.replace('/repos/o/r', '');
    if (p === '/pulls/5') {
      const body = opts.prBody ?? '変更の説明\n\nCloses #7';
      return json({ number: 5, title: 'PR の題', body, state: 'open', draft: true, head: { ref: 'h', sha: HEAD }, base: { ref: 'main', sha: OLD1 }, user: null });
    }
    if (p === '/issues/7') return json({ number: 7, title: 'Issue の題', body: 'Issue の本文', state: 'open', labels: [] });
    if (p === '/issues/7/comments') return json(opts.issueComments ?? ISSUE_COMMENTS);
    if (p === '/issues/5/comments') return json(opts.prComments ?? PR_COMMENTS);
    if (p === `/compare/main...${HEAD}`) return new Response(DIFF);
    const file = p.startsWith('/contents/') ? FILES[decodeURIComponent(p.slice('/contents/'.length))] : undefined;
    if (file !== undefined && url.searchParams.get('ref') === HEAD) return new Response(file);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  const gh = createGitHubClient({ token: 't', owner: 'o', repo: 'r', fetch });
  const material = await collectMaterial(gh, config, { owner: 'o', repo: 'r', pr: 5, headSha: HEAD, appLogin: APP, reviewLogin: REVIEWER });
  return { material, calls };
};

test('Closes の Issue と最新の plan-gate 記録の plan、上限で切った diff とファイル（削除は読まない）、head が違う最後の前回の記録を集める', async () => {
  const { material, calls } = await collect();
  assert.equal(material.repository, 'o/r');
  assert.deepStrictEqual(material.pr, { number: 5, title: 'PR の題', body: '変更の説明\n\nCloses #7', baseRef: 'main', headSha: HEAD });
  assert.deepStrictEqual(material.issue, { number: 7, title: 'Issue の題', body: 'Issue の本文' });
  assert.deepStrictEqual(material.plan, { v: 'new' });

  assert.ok(DIFF.length > config.claude.maxDiffChars);
  assert.equal(material.diff, DIFF.slice(0, config.claude.maxDiffChars));
  assert.equal(material.diffTruncated, true);
  assert.deepStrictEqual(material.files, [
    { path: 'src/a.ts', content: 'A'.repeat(10), truncated: true },
    { path: 'src/new.ts', content: 'short', truncated: false },
  ]);
  assert.ok(!calls.some((c) => c.includes('gone.ts')), calls.join('\n'));

  assert.deepStrictEqual(material.previous, shadow(OLD2));
});

test('Closes が無い・2つなら Issue を読まず issue と plan が null', async () => {
  for (const [name, prBody] of [
    ['Closes が無い', '変更の説明だけ'],
    ['Closes が2つ', 'Closes #1\nCloses #2'],
  ] as const) {
    const { material, calls } = await collect({ prBody });
    assert.equal(material.issue, null, name);
    assert.equal(material.plan, null, name);
    assert.deepStrictEqual(calls.filter((c) => c.includes('/issues/') && !c.includes('/issues/5/')), [], name);
  }
});

test('最後の plan-gate 記録に plan が無ければ、前の記録に plan があっても plan は null', async () => {
  const issueComments = [comment(1, APP, appRecord({ status: 'ok', plan: { v: 'old' } })), comment(2, APP, appRecord({ status: 'stopped' }))];
  const { material } = await collect({ issueComments });
  assert.deepStrictEqual(material.issue, { number: 7, title: 'Issue の題', body: 'Issue の本文' });
  assert.equal(material.plan, null);
});

test('前回の記録は reviewLogin の名義のものだけを読み、ゲートの App やほかの人の名義の、より新しい記録は読まない', async () => {
  const NEWER = 'd'.repeat(40);
  const prComments = [...PR_COMMENTS, comment(20, APP, renderShadowComment(shadow(NEWER))), comment(21, 'someone', renderShadowComment(shadow(NEWER)))];
  const { material } = await collect({ prComments });
  assert.deepStrictEqual(material.previous, shadow(OLD2));
});

test('collect.ts は cloudflare:workers・@anthropic-ai/sdk・node:・harness/lib を import しない', () => {
  const source = readFileSync(fileURLToPath(new URL('../../review-api/src/collect.ts', import.meta.url)), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const banned = specifiers.filter((s) => /^cloudflare:workers$|^@anthropic-ai\/sdk|^node:|harness\/lib/.test(s));
  assert.deepEqual(banned, [], specifiers.join(','));
});
