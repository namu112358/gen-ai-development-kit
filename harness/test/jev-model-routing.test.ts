// 実装のモデル（Opus / Sonnet）の Jev の問い・記録・use の決め方（harness/lib/model-routing.ts）を確かめる（Issue #139 の AC1・AC2）。
// 問いの材料は App が集めたものだけ（計画の本文を含まない）、問いは英語、Jev の失敗はゲートを止めない記録になる、
// show-plan が出す use は enforce で ok の勧めがあるときだけ勧め・それ以外は fleet.implementModel。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { skillProblems, type SkillSpec } from './support/skill-text.ts';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import {
  MODEL_ROUTING_QUESTION_SET,
  buildModelRoutingRequest,
  implementationRouting,
  modelRoutingInputs,
  modelRoutingMode,
  recommendModel,
  reusableModelRouting,
  routeModel,
  type ModelRoutingRecord,
} from '../lib/model-routing.ts';

const root = join(import.meta.dirname, '..', '..');
const base = loadConfig();

/** 読み込んだ設定を写し、jev.modelRouting・jev.maxDiffChars・fleet.implementModel を変える（undefined は消す） */
function cfg(o: { routing?: string; maxDiffChars?: number; implementModel?: 'opus' | 'sonnet' } = {}): HarnessConfig {
  const jev: Record<string, unknown> = { ...base.jev, ...(o.maxDiffChars !== undefined ? { maxDiffChars: o.maxDiffChars } : {}) };
  if (o.routing === undefined) delete jev.modelRouting;
  else jev.modelRouting = o.routing;
  const fleet = { ...((base as { fleet?: object }).fleet ?? {}), ...(o.implementModel ? { implementModel: o.implementModel } : {}) };
  return { ...base, jev, fleet } as unknown as HarnessConfig;
}

const ISSUE = { title: 'feat: 何かを足す', body: '### Goal\n\n何かを足す。' };
const FILES = ['harness/lib/a.ts', 'harness/test/a.test.ts', 'docs/x.md', 'Makefile', 'docs/*.md'];

const choice = (opus: unknown, sonnet: unknown) => ({ implementation_model: { type: 'choice', choice: 'opus', probabilities: { opus, sonnet } as Record<string, number> } });

/** 偽の ask。呼ばれた要求を残し、reply を返す（throw なら投げる） */
function fakeAsk(reply: Awaited<ReturnType<typeof askJev>> | 'throw') {
  const asked: { state: any; questions: Record<string, any> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request as { state: any; questions: Record<string, any> });
    if (reply === 'throw') throw new Error('boom');
    return reply;
  };
  return { asked, fn };
}

const CJK = /[　-ヿ㐀-鿿＀-￯]/;

test('modelRoutingMode：off・enforce はそのまま、無い・ほかの値は shadow', () => {
  const cases: [string | undefined, string][] = [['off', 'off'], ['enforce', 'enforce'], ['shadow', 'shadow'], [undefined, 'shadow'], ['Enforce', 'shadow'], ['', 'shadow']];
  for (const [routing, want] of cases) assert.equal(modelRoutingMode(cfg({ routing })), want, String(routing));
});

test('modelRoutingInputs：件数・拡張子ごとの件数（(none)・(pattern)）・テストファイルの数・ガードレールに触れるか', () => {
  const inputs = modelRoutingInputs(base, FILES, ['harness/lib/a.ts']);
  assert.deepEqual(inputs, { fileCount: 5, fileKinds: { '.ts': 2, '.md': 1, '(none)': 1, '(pattern)': 1 }, testFileCount: 1, touchesGuardrail: true });
  assert.equal(modelRoutingInputs(base, ['docs/x.md'], []).touchesGuardrail, false);
});

test('buildModelRoutingRequest：state は App が集めた7つのキーだけで、問いは implementation_model の choice（opus・sonnet）、英語だけ', () => {
  const inputs = modelRoutingInputs(base, FILES, []);
  const req = buildModelRoutingRequest(base, ISSUE, FILES, inputs);
  assert.equal(req.model, base.jev.model);
  assert.deepEqual(Object.keys(req.state).sort(), ['file_count', 'file_kinds', 'issue_body', 'issue_title', 'planned_files', 'test_file_count', 'touches_guardrail']);
  const state = req.state as Record<string, unknown>;
  assert.equal(state.issue_title, ISSUE.title);
  assert.equal(state.issue_body, ISSUE.body);
  assert.deepEqual(state.planned_files, FILES);
  assert.equal(state.file_count, 5);
  assert.equal(state.touches_guardrail, false);
  assert.deepEqual(Object.keys(req.questions), ['implementation_model']);
  const q = (req.questions as Record<string, any>).implementation_model;
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria).sort(), ['opus', 'sonnet']);
  assert.ok(!CJK.test(q.instructions), `instructions に日本語がある: ${q.instructions}`);
  for (const [k, v] of Object.entries(q.criteria as Record<string, string>)) assert.ok(!CJK.test(v), `criteria.${k} に日本語がある: ${v}`);
});

test('recommendModel：確率の高いほう、同じなら opus、確率が欠ける・数でないなら null', () => {
  assert.deepEqual(recommendModel(choice(0.3, 0.7) as any), { recommended: 'sonnet', probabilities: { opus: 0.3, sonnet: 0.7 } });
  assert.deepEqual(recommendModel(choice(0.6, 0.4) as any), { recommended: 'opus', probabilities: { opus: 0.6, sonnet: 0.4 } });
  assert.deepEqual(recommendModel(choice(0.5, 0.5) as any), { recommended: 'opus', probabilities: { opus: 0.5, sonnet: 0.5 } });
  const broken: [string, unknown][] = [
    ['問いが無い', {}],
    ['probabilities が無い', { implementation_model: { type: 'choice', choice: 'opus' } }],
    ['sonnet が無い', { implementation_model: { type: 'choice', probabilities: { opus: 1 } } }],
    ['opus が数でない', choice('0.5', 0.5)],
  ];
  for (const [name, answers] of broken) assert.equal(recommendModel(answers as any), null, name);
});

test('routeModel：off は null で Jev を呼ばない。鍵なし・材料が大きすぎるは skipped で呼ばない', async () => {
  const off = fakeAsk({ status: 'ok', model: 'm', answers: choice(0.1, 0.9) as any });
  assert.equal(await routeModel(cfg({ routing: 'off' }), 'key', ISSUE, FILES, [], off.fn), null);
  assert.equal(off.asked.length, 0);

  const cases: [string, HarnessConfig, string | undefined][] = [
    ['鍵なし', cfg({ routing: 'shadow' }), undefined],
    ['大きすぎる', cfg({ routing: 'shadow', maxDiffChars: 10 }), 'key'],
  ];
  for (const [name, config, key] of cases) {
    const ask = fakeAsk({ status: 'ok', model: 'm', answers: choice(0.1, 0.9) as any });
    const r = await routeModel(config, key, ISSUE, FILES, [], ask.fn);
    assert.equal(r?.status, 'skipped', name);
    assert.equal(r?.mode, 'shadow', name);
    assert.equal(r?.questionSet, MODEL_ROUTING_QUESTION_SET, name);
    assert.deepEqual(r?.inputs, modelRoutingInputs(config, FILES, []), name);
    assert.equal(r?.recommended, undefined, name);
    assert.equal(ask.asked.length, 0, `${name}: Jev を呼んだ`);
  }
});

test('routeModel：ok なら勧め・確率・モード・材料を記録し、error・throw・確率が読めない答えは status error（投げない）', async () => {
  const ok = fakeAsk({ status: 'ok', model: 'm', answers: choice(0.8, 0.2) as any });
  const r = await routeModel(cfg({ routing: 'enforce' }), 'key', ISSUE, FILES, ['harness/lib/a.ts'], ok.fn);
  assert.equal(ok.asked.length, 1);
  assert.deepEqual(Object.keys(ok.asked[0]!.questions), ['implementation_model']);
  assert.equal(r?.status, 'ok');
  assert.equal(r?.mode, 'enforce');
  assert.equal(r?.recommended, 'opus');
  assert.deepEqual(r?.probabilities, { opus: 0.8, sonnet: 0.2 });
  assert.deepEqual(r?.inputs, modelRoutingInputs(base, FILES, ['harness/lib/a.ts']));
  assert.equal(r?.questionSet, MODEL_ROUTING_QUESTION_SET);

  const failures: [string, Parameters<typeof fakeAsk>[0], RegExp | null][] = [
    ['error', { status: 'error', detail: 'HTTP 500: ***' }, /HTTP 500/],
    ['throw', 'throw', null],
    ['確率が読めない', { status: 'ok', model: 'm', answers: {} }, null],
  ];
  for (const [name, reply, detail] of failures) {
    const rec = await routeModel(cfg({ routing: 'shadow' }), 'key', ISSUE, FILES, [], fakeAsk(reply).fn);
    assert.equal(rec?.status, 'error', name);
    assert.equal(rec?.mode, 'shadow', name);
    assert.equal(rec?.recommended, undefined, name);
    assert.equal(rec?.questionSet, MODEL_ROUTING_QUESTION_SET, name);
    if (detail) assert.match(rec?.detail ?? '', detail, name);
  }
});

const okRecord = (recommended: 'opus' | 'sonnet', p = 0.8): ModelRoutingRecord => ({
  status: 'ok', mode: 'shadow', recommended, probabilities: recommended === 'opus' ? { opus: p, sonnet: 1 - p } : { opus: 1 - p, sonnet: p },
  inputs: { fileCount: 1, fileKinds: { '.md': 1 }, testFileCount: 0, touchesGuardrail: false }, questionSet: MODEL_ROUTING_QUESTION_SET,
});

test('reusableModelRouting：同じ計画コメント・同じ本文・今の questionSet の ok の記録だけ使い回す', () => {
  const routing = okRecord('sonnet');
  const prev = (patch: Record<string, unknown> = {}) => ({ version: 1, planCommentId: 7, planBodySha256: 'h', pass: true, reasons: [], modelRouting: routing, ...patch }) as any;
  assert.deepEqual(reusableModelRouting(prev(), 7, 'h'), routing);
  const cases: [string, unknown][] = [
    ['前の記録が無い', undefined],
    ['別の計画コメント', prev({ planCommentId: 8 })],
    ['本文が違う', prev({ planBodySha256: 'x' })],
    ['modelRouting が無い', prev({ modelRouting: undefined })],
    ['error', prev({ modelRouting: { ...routing, status: 'error', recommended: undefined, probabilities: undefined } })],
    ['skipped', prev({ modelRouting: { ...routing, status: 'skipped', recommended: undefined, probabilities: undefined } })],
    ['古い questionSet', prev({ modelRouting: { ...routing, questionSet: MODEL_ROUTING_QUESTION_SET - 1 } })],
  ];
  for (const [name, previous] of cases) assert.equal(reusableModelRouting(previous as any, 7, 'h'), null, name);
});

test('AC2 implementationRouting：use は enforce で ok の勧めがあるときだけ勧め、それ以外は fleet.implementModel。mode は今の設定', () => {
  const error: ModelRoutingRecord = { ...okRecord('opus'), status: 'error', recommended: undefined, probabilities: undefined, detail: 'HTTP 500' };
  const skipped: ModelRoutingRecord = { ...okRecord('opus'), status: 'skipped', recommended: undefined, probabilities: undefined, detail: 'JEV_API_KEY が未設定' };
  const cases: [string, HarnessConfig, ModelRoutingRecord | undefined, { mode: string; recommended: string | null; probability: number | null; use: string }][] = [
    ['enforce＋ok sonnet', cfg({ routing: 'enforce', implementModel: 'opus' }), okRecord('sonnet', 0.7), { mode: 'enforce', recommended: 'sonnet', probability: 0.7, use: 'sonnet' }],
    ['enforce＋ok opus', cfg({ routing: 'enforce', implementModel: 'sonnet' }), okRecord('opus', 0.9), { mode: 'enforce', recommended: 'opus', probability: 0.9, use: 'opus' }],
    ['shadow＋ok sonnet は既定（opus）', cfg({ routing: 'shadow', implementModel: 'opus' }), okRecord('sonnet', 0.7), { mode: 'shadow', recommended: 'sonnet', probability: 0.7, use: 'opus' }],
    ['shadow＋ok opus は既定（sonnet）', cfg({ routing: 'shadow', implementModel: 'sonnet' }), okRecord('opus', 0.9), { mode: 'shadow', recommended: 'opus', probability: 0.9, use: 'sonnet' }],
    ['enforce＋error', cfg({ routing: 'enforce', implementModel: 'sonnet' }), error, { mode: 'enforce', recommended: null, probability: null, use: 'sonnet' }],
    ['enforce＋skipped', cfg({ routing: 'enforce', implementModel: 'opus' }), skipped, { mode: 'enforce', recommended: null, probability: null, use: 'opus' }],
    ['enforce＋記録なし', cfg({ routing: 'enforce', implementModel: 'sonnet' }), undefined, { mode: 'enforce', recommended: null, probability: null, use: 'sonnet' }],
    ['未指定は shadow', cfg({ implementModel: 'sonnet' }), okRecord('opus', 0.9), { mode: 'shadow', recommended: 'opus', probability: 0.9, use: 'sonnet' }],
  ];
  for (const [name, config, record, want] of cases) assert.deepEqual(implementationRouting(config, record), want, name);
  // off：前に ok の記録があっても既定のモデル
  const off = implementationRouting(cfg({ routing: 'off', implementModel: 'sonnet' }), okRecord('opus', 0.9));
  assert.deepEqual({ mode: off.mode, use: off.use }, { mode: 'off', use: 'sonnet' });
});

test('AC2 show-plan：出力に implementationRouting の modelRouting を出す（plan.ts が implementationRouting を使う）', () => {
  const src = readFileSync(join(root, 'harness', 'scripts', 'agent', 'commands', 'plan.ts'), 'utf8');
  assert.ok(src.includes('implementationRouting'), 'show-plan が implementationRouting を使っていない');
  assert.ok(src.includes('modelRouting'), 'show-plan の出力に modelRouting が無い');
});

test('harness.config.json と雛形：jev.modelRouting は shadow', () => {
  for (const path of [join(root, 'harness.config.json'), join(root, 'harness', 'templates', 'harness.config.json')]) {
    const json = JSON.parse(readFileSync(path, 'utf8')) as { jev?: { modelRouting?: unknown } };
    assert.equal(json.jev?.modelRouting, 'shadow', path);
  }
});

// ship の skill の節「実装のモデル（fleet から起こされた ship）」が show-plan の modelRouting.use でモデルを選ぶ手順か（語の有無だけ。AC2。
// README の表のパターンに合わせ、計画の ship-model-routing.test.ts ではなくこのファイルに置く）
const SHIP_ROUTING_SPEC: SkillSpec = {
  path: '.claude/skills/ship/SKILL.md',
  parts: [
    {
      section: '## 実装のモデル（fleet から起こされた ship）',
      words: ['show-plan', 'modelRouting.use', 'enforce', 'implementModel', 'agent:plan-review'],
    },
  ],
};

test('ship の skill：実装のモデルの節に show-plan・modelRouting.use・enforce・implementModel・agent:plan-review がある', () => {
  assert.deepEqual(skillProblems(SHIP_ROUTING_SPEC), []);
});
