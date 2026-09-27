import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.ts';
import { buildTriageRequest, renderTriage, summarizeTriage } from '../lib/issue-triage.ts';

const config = loadConfig();
const contract = { goal: 'g', background: '', requirements: 'r', nonGoals: '', acceptanceCriteria: '- [ ] a', dependencies: '', validation: '' };

test('5問を1回で問い、領域の選択肢は設定の area と other', () => {
  const req = buildTriageRequest(config, 't', contract);
  assert.deepEqual(Object.keys(req.questions), ['type', 'area', 'priority', 'ac_verifiable', 'requirements_clear']);
  const area = req.questions.area as { criteria: Record<string, string> };
  assert.deepEqual(Object.keys(area.criteria), [...Object.keys(config.classification.areas), 'other']);
  assert.equal(req.state.acceptance_criteria, '- [ ] a');
});

test('要約：最も確率の高い選択肢と、書き方の警告', () => {
  const s = summarizeTriage({
    type: { type: 'choice', probabilities: { docs: 0.8, feature: 0.2 } },
    area: { type: 'choice', probabilities: { docs: 0.9, other: 0.1 } },
    priority: { type: 'choice', probabilities: { normal: 0.7, high: 0.2, low: 0.1 } },
    ac_verifiable: { type: 'noul', noul: 0.3 },
    requirements_clear: { type: 'noul', noul: 0.9 },
  });
  assert.deepEqual(s.type, ['docs', 0.8]);
  assert.equal(s.warnings.length, 1);
  assert.match(renderTriage(s), /\| 種類 \| docs \| 80% \|/);
});

test('答えが欠けていても落ちず、警告にする', () => {
  const s = summarizeTriage({});
  assert.equal(s.type[0], '?');
  assert.equal(s.warnings.length, 2);
});
