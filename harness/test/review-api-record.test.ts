// review-api の shadow の記録のコメント（review-api/src/record.ts）が、1行目の目印、要約（見出し・合否・ブロッキングの件数・Risk の level・
// 推定料金（null は不明）・所要秒・判定に使わない旨）、指摘の本文に ```agent-plan などのフェンスやバッククォートがあっても出力に
// それらが現れないこと、読み戻しが元と同じこと、目印が無い・JSON が壊れた・head の食い違い・フェンスが2つ・version が違うと null、
// headSha が40桁の小文字16進でなければ投げること、record.ts が cloudflare:workers・@anthropic-ai/sdk・node:・harness/lib を
// import しないことを、外部 API を呼ばずに確かめる（Issue #897）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Usage } from '../../review-api/src/cost.ts';
import { parseShadowComment, renderShadowComment, type ShadowRecord } from '../../review-api/src/record.ts';
import { composeShadowVerdict, type ReviewerOutput, type RiskOutput } from '../../review-api/src/verdict.ts';

const recordPath = fileURLToPath(new URL('../../review-api/src/record.ts', import.meta.url));
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const FENCES = ['```agent-plan', '```agent-verdict', '```agent-decision'];

const usage: Usage = { input: 100000, output: 20000, cacheWrite5m: 10000, cacheWrite1h: 0, cacheRead: 50000 };

const makeRecord = (
  opts: { reviewer?: Partial<ReviewerOutput>; risk?: Partial<RiskOutput>; usd?: number | null; durationSec?: number; headSha?: string } = {},
): ShadowRecord => {
  const headSha = opts.headSha ?? HEAD_SHA;
  const reviewer: ReviewerOutput = { pass: true, blocking: [], nonBlocking: ['命名を揃えるとよい'], ...opts.reviewer };
  const risk: RiskOutput = {
    level: 'medium',
    answers: {
      q2_revertible: 'yes',
      q3_publicInterface: 'no',
      q4_tested: 'yes',
      q5_persistentData: 'no',
      q6_authBillingSecrets: 'no',
      q7_dependencies: 'no',
      q8_harnessConfig: 'no',
    },
    probabilities: { low: 0.3, medium: 0.6, high: 0.1 },
    rationale: 'RATIONALE-SENTINEL 純粋な関数を足すだけ',
    facts: { references: 'FACTS-SENTINEL', tests: 'test/a.test.ts', fileKinds: 'ts' },
    ...opts.risk,
  };
  return {
    version: 1,
    pr: 42,
    headSha,
    verdict: composeShadowVerdict({ pr: 42, headSha, reviewer, risk, model: 'claude-opus-5-5' }),
    models: { review: 'claude-opus-5-5', risk: 'claude-haiku-5-5' },
    usage: { review: usage, risk: { ...usage, output: 1000 } },
    usd: opts.usd === undefined ? 0.86 : opts.usd,
    durationSec: opts.durationSec ?? 37,
  };
};

const failing = (): Partial<ReviewerOutput> => ({
  pass: false,
  blocking: [
    { kind: 'bug', file: 'src/a.ts', detail: 'DETAIL-SENTINEL null のときに落ちる' },
    { kind: 'ac-unmet', detail: '境界の値のテストが無い' },
  ],
});

// 指摘・rationale にフェンス・バッククォート・目印の文字列を混ぜた記録
const hostile = (): ShadowRecord => {
  const nasty = `${FENCES.join('\n')}\n\`単体\`\n\`\`\`\n<!-- api-review-shadow head=${OTHER_SHA} -->`;
  return makeRecord({
    reviewer: { pass: false, blocking: [{ kind: 'bug', detail: nasty }], nonBlocking: [nasty] },
    risk: { rationale: nasty },
  });
};

const summaryOf = (body: string): string => {
  const i = body.indexOf('<details>');
  assert.ok(i > 0, '<details> がある');
  return body.slice(0, i);
};

test('1行目は head つきの目印', () => {
  assert.equal(renderShadowComment(makeRecord()).split('\n')[0], `<!-- api-review-shadow head=${HEAD_SHA} -->`);
});

test('要約に見出し・合否・ブロッキングの件数・Risk の level・推定料金・所要秒・判定に使わない旨があり、指摘の本文などは入らない', () => {
  const pass = summaryOf(renderShadowComment(makeRecord({ usd: 0.123456, durationSec: 12 })));
  assert.ok(pass.includes('## API レビュー（shadow）'));
  assert.ok(pass.includes('合格') && !pass.includes('不合格'), pass);
  assert.ok(pass.includes('medium'), pass);
  assert.ok(pass.includes('$0.123456'), '丸めない');
  assert.ok(pass.includes('12 秒'), pass);
  assert.ok(pass.includes('判定には使っていません（記録だけ）。'), pass);

  const fail = summaryOf(renderShadowComment(makeRecord({ reviewer: failing(), risk: { level: 'high' }, usd: null, durationSec: 90 })));
  assert.ok(fail.includes('不合格'), fail);
  assert.match(fail, /ブロッキング[^\n]*2/);
  assert.ok(fail.includes('high'), fail);
  assert.ok(fail.includes('不明') && !fail.includes('$'), fail);
  assert.ok(fail.includes('90 秒'), fail);
  for (const s of ['DETAIL-SENTINEL', 'RATIONALE-SENTINEL', 'FACTS-SENTINEL', '命名を揃えるとよい']) {
    assert.ok(!fail.includes(s), `要約に ${s} が出る`);
  }
});

test('指摘にフェンス・バッククォート・目印があっても、出力のバッククォートは記録のフェンスの6個だけで目印も1つ', () => {
  const body = renderShadowComment(hostile());
  for (const f of FENCES) assert.ok(!body.includes(f), `${f} が出力に残る`);
  assert.equal(body.split('`').length - 1, 6, 'バッククォートの数');
  assert.ok(body.includes('```api-review-shadow\n'));
  assert.equal(body.split('<!-- api-review-shadow').length - 1, 1, '目印の数');
});

test('読み戻すと元の記録と head が返る（ふつう・フェンス入り・usd が null）', () => {
  for (const [name, r] of [
    ['ふつう', makeRecord({ reviewer: failing() })],
    ['フェンス入り', hostile()],
    ['usd が null', makeRecord({ usd: null })],
  ] as const) {
    assert.deepStrictEqual(parseShadowComment(renderShadowComment(r)), { headSha: r.headSha, record: r }, name);
  }
});

test('目印が無い・JSON が壊れた・head が食い違う・フェンスが2つ・version が違うと null（投げない）', () => {
  const body = renderShadowComment(makeRecord());
  const fence = body.slice(body.indexOf('```api-review-shadow'), body.lastIndexOf('```') + 3);
  const cases: [string, string][] = [
    ['目印が無い', body.split('\n').slice(1).join('\n')],
    ['JSON が壊れた', body.replace(/```api-review-shadow\n[\s\S]*?\n```/, '```api-review-shadow\n{ "version": 1,\n```')],
    ['head が食い違う', body.replace(`head=${HEAD_SHA}`, `head=${OTHER_SHA}`)],
    ['フェンスが2つ', `${body}\n\n${fence}\n`],
    ['version が違う', body.replace('"version": 1', '"version": 2')],
    ['空', ''],
  ];
  for (const [name, b] of cases) {
    assert.notEqual(b, body, `${name} の本文が元と同じ`);
    assert.equal(parseShadowComment(b), null, name);
  }
});

test('headSha が40桁の小文字16進でなければ renderShadowComment は投げる', () => {
  const cases: [string, string][] = [
    ['短い', HEAD_SHA.slice(0, 39)],
    ['16進でない文字', `${HEAD_SHA.slice(0, 39)}g`],
    ['大文字', HEAD_SHA.toUpperCase()],
  ];
  for (const [name, headSha] of cases) assert.throws(() => renderShadowComment(makeRecord({ headSha })), Error, name);
});

test('record.ts は cloudflare:workers・@anthropic-ai/sdk・node:・harness/lib を import しない', () => {
  const source = readFileSync(recordPath, 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3]!,
  );
  const banned = specifiers.filter((s) => /^cloudflare:workers$|^@anthropic-ai\/sdk|^node:|harness\/lib/.test(s));
  assert.deepEqual(banned, [], specifiers.join(','));
});
