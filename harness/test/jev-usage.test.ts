import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { askJev, buildJevRequest, callJev, measureRequest } from '../lib/jev.ts';

// Jev に送る材料の大きさ（文字数・日本語の割合）と、応答の usage.input_tokens を記録に残す（Issue #129）

const base = loadConfig();
/** jev.mode を shadow にした設定（記録だけ取る段階） */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'shadow' } };
const facts = { references: 'r', tests: 't', fileKinds: 'k' };

/** 日本語の文字（U+3000〜U+30FF・U+3400〜U+9FFF・U+FF00〜U+FFEF）の割合を小数3桁に丸めたもの（テスト側の期待値） */
function expectedJaRatio(s: string): number {
  if (s.length === 0) return 0;
  let ja = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x3000 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef)) ja++;
  }
  return Math.round((ja / s.length) * 1000) / 1000;
}

/** Jev の応答の本文（usage を渡せば付ける） */
function jevBody(usage?: unknown): string {
  return JSON.stringify({
    model: 'jev-1.13.0',
    answers: { q1_risk: { type: 'choice', choice: 'low', probabilities: { low: 1 } }, q2_revertible: { type: 'noul', noul: 0.99 } },
    ...(usage === undefined ? {} : { usage }),
  });
}

/** 偽の fetch。呼ばれた回数を数える */
function fakeFetch(body: string, status = 200) {
  const calls: string[] = [];
  const fn: typeof fetch = async (url) => {
    calls.push(String(url));
    return new Response(body, { status });
  };
  return { calls, fn };
}

// --- measureRequest ---

test('measureRequest：英語だけの材料なら jaRatio は 0', () => {
  const m = measureRequest({ state: { diff: 'diff --git a/x b/x\n+hello', changed_files: ['x'] }, questions: { q: { instructions: 'Is it safe?' } } });
  assert.equal(m.jaRatio, 0);
  assert.ok(m.chars > 0);
});

test('measureRequest：chars は JSON.stringify({ state, questions }).length と一致する', () => {
  const state = { diff: '+追加した行\n-消した行', changed_files: ['docs/a.md'] };
  const questions = { q1: { type: 'noul', instructions: 'Is it safe?' } };
  const m = measureRequest({ state, questions });
  assert.equal(m.chars, JSON.stringify({ state, questions }).length);
});

test('measureRequest：渡したオブジェクトに model があっても数えない', () => {
  const state = { diff: 'x' };
  const questions = { q: { instructions: 'y' } };
  const without = measureRequest({ state, questions });
  const withModel = measureRequest({ model: 'jev-1.13.0-with-a-long-model-name', state, questions } as { state: unknown; questions: Record<string, unknown> });
  assert.equal(withModel.chars, without.chars);
  assert.equal(withModel.chars, JSON.stringify({ state, questions }).length);
});

test('measureRequest：日本語を含む state では jaRatio が上がり、日本語の文字の割合（小数3桁）になる', () => {
  const questions = { q: { instructions: 'Is it safe?' } };
  const en = measureRequest({ state: { diff: '+add a line about the release' }, questions });
  const jaState = { diff: '+リリースの手順について一行を追加する。日本語の説明文です。' };
  const ja = measureRequest({ state: jaState, questions });
  assert.ok(ja.jaRatio > en.jaRatio, `日本語を含むのに割合が上がらない: ${ja.jaRatio} <= ${en.jaRatio}`);
  assert.ok(ja.jaRatio > 0 && ja.jaRatio <= 1);
  assert.equal(ja.jaRatio, expectedJaRatio(JSON.stringify({ state: jaState, questions })));
});

test('measureRequest：全角英数（U+FF00〜U+FFEF）と CJK 拡張 A（U+3400〜）も日本語として数える', () => {
  const questions = {};
  const state = 'ＡＢＣ㐀';
  const m = measureRequest({ state, questions });
  assert.equal(m.jaRatio, expectedJaRatio(JSON.stringify({ state, questions })));
  assert.ok(m.jaRatio > 0);
});

test('measureRequest：jaRatio は小数3桁に丸める', () => {
  const m = measureRequest({ state: { diff: 'あ' + 'a'.repeat(300) }, questions: { q: 'x' } });
  assert.equal(m.jaRatio, Math.round(m.jaRatio * 1000) / 1000);
  assert.equal(m.jaRatio, expectedJaRatio(JSON.stringify({ state: { diff: 'あ' + 'a'.repeat(300) }, questions: { q: 'x' } })));
});

// --- askJev ---

test('askJev：応答の usage.input_tokens が整数なら inputTokens に入る', async () => {
  const f = fakeFetch(jevBody({ input_tokens: 1234, output_tokens: 20 }));
  const r = await askJev('k', buildJevRequest(config, 'd', ['x'], facts), f.fn);
  assert.equal(r.status, 'ok');
  assert.equal((r as { inputTokens?: number | null }).inputTokens, 1234);
});

test('askJev：usage が無い応答では inputTokens は null', async () => {
  const r = await askJev('k', buildJevRequest(config, 'd', ['x'], facts), fakeFetch(jevBody()).fn);
  assert.equal(r.status, 'ok');
  assert.equal((r as { inputTokens?: number | null }).inputTokens, null);
});

test('askJev：usage.input_tokens が整数でなければ inputTokens は null', async () => {
  for (const usage of [{ input_tokens: 12.5 }, { input_tokens: '1234' }, { output_tokens: 20 }]) {
    const r = await askJev('k', buildJevRequest(config, 'd', ['x'], facts), fakeFetch(jevBody(usage)).fn);
    assert.equal(r.status, 'ok');
    assert.equal((r as { inputTokens?: number | null }).inputTokens, null, JSON.stringify(usage));
  }
});

test('askJev：エラーの戻り値は変えない（status と detail だけ）', async () => {
  const r = await askJev('k', buildJevRequest(config, 'd', ['x'], facts), fakeFetch('bad', 401).fn);
  assert.equal(r.status, 'error');
  assert.deepEqual(Object.keys(r).sort(), ['detail', 'status']);
});

// --- callJev ---

test('callJev：ok の記録に size（chars・jaRatio・inputTokens・diffChars）が付く', async () => {
  const diff = 'diff --git a/docs/a.md b/docs/a.md\n+日本語の説明を足す';
  const files = ['docs/a.md'];
  const rec = await callJev(config, 'k', diff, files, facts, fakeFetch(jevBody({ input_tokens: 1234, output_tokens: 20 })).fn);
  assert.equal(rec.status, 'ok');
  const m = measureRequest(buildJevRequest(config, diff, files, facts));
  assert.deepEqual(rec.size, { chars: m.chars, jaRatio: m.jaRatio, inputTokens: 1234, diffChars: diff.length });
});

test('callJev：usage の無い応答では size.inputTokens が null（size は付く）', async () => {
  const diff = 'diff --git a/x b/x\n+a';
  const rec = await callJev(config, 'k', diff, ['x'], facts, fakeFetch(jevBody()).fn);
  assert.equal(rec.status, 'ok');
  assert.ok(rec.size, 'size が無い');
  assert.equal(rec.size!.inputTokens, null);
  assert.equal(rec.size!.diffChars, diff.length);
  assert.equal(rec.size!.chars, measureRequest(buildJevRequest(config, diff, ['x'], facts)).chars);
});

test('callJev：skip（jev.mode=off・キーなし・大きすぎる diff）の記録には size を付けない', async () => {
  const f = fakeFetch(jevBody({ input_tokens: 1 }));
  const off: HarnessConfig = { ...config, jev: { ...config.jev, mode: 'off' } };
  const records = [
    await callJev(off, 'k', 'd', [], facts, f.fn),
    await callJev(config, undefined, 'd', [], facts, f.fn),
    await callJev(config, 'k', 'x'.repeat(config.jev.maxDiffChars + 1), [], facts, f.fn),
  ];
  for (const rec of records) {
    assert.equal(rec.status, 'skipped');
    assert.equal('size' in rec, false, JSON.stringify(rec));
  }
  assert.equal(f.calls.length, 0, 'skip のときは Jev を呼ばない');
});

test('callJev：error の記録には size を付けない', async () => {
  const rec = await callJev(config, 'k', 'd', [], facts, fakeFetch('bad key', 401).fn);
  assert.equal(rec.status, 'error');
  assert.equal('size' in rec, false, JSON.stringify(rec));
});
