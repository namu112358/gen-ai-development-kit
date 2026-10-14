// このリポジトリの harness.config.json が reviewSource を mode api で持ち、review-api の置き場所をガードレール・delegateMergeExclude に足していること、
// 雛形は mode local のままであることを確かめる（Issue #1081）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig, reviewSourceConfig, type HarnessConfig } from '../lib/config.ts';
import { delegateExcludeFiles } from '../lib/delegate.ts';
import { guardrailFiles } from '../lib/guardrail.ts';

const config = loadConfig();
const template = JSON.parse(readFileSync(new URL('../templates/harness.config.json', import.meta.url), 'utf8')) as HarnessConfig;

const ADDED_GUARDRAIL = ['review-api/**'];
const ADDED_DELEGATE = ['review-api/**', 'harness/lib/api-review.ts', 'harness/scripts/agent/commands/api-review.ts'];
const FILES = ['review-api/src/prompts.ts', 'review-api/wrangler.jsonc', 'review-api/wrangler.json', 'harness/lib/api-review.ts', 'harness/scripts/agent/commands/api-review.ts'];

test('実物の reviewSource は mode api・8 分・harness-review-agent[bot]、雛形は mode local', () => {
  assert.deepEqual(reviewSourceConfig(config), { mode: 'api', waitMinutes: 8, appLogin: 'harness-review-agent[bot]', routineWaitMinutes: 20 });
  assert.equal(reviewSourceConfig(template).mode, 'local');
});

test('review-api と api-review のファイルはガードレールにも delegateMergeExclude にも当たる', () => {
  assert.deepEqual(guardrailFiles(config, FILES), [...FILES].sort());
  assert.deepEqual(delegateExcludeFiles(config, FILES), [...FILES].sort());
});

test('足した項目は末尾にあり、重複が無く、既存の項目が残る', () => {
  const cases: [string, string[], string[], string[]][] = [
    ['guardrailPaths', config.guardrailPaths ?? [], ADDED_GUARDRAIL, ['harness.config.json', 'harness/gates/**', '.claude/skills/judge/SKILL.md', '.github/**', 'harness/lib/**']],
    ['delegateMergeExclude', config.delegateMergeExclude ?? [], ADDED_DELEGATE, ['harness.config.json', 'harness/gates/**', '.claude/skills/judge/SKILL.md', 'harness/lib/merge-route.ts', 'harness/lib/session-inputs.ts']],
  ];
  for (const [name, list, added, kept] of cases) {
    assert.deepEqual(list.slice(-added.length), added, name);
    assert.equal(new Set(list).size, list.length, `${name} に重複がある`);
    for (const k of kept) assert.ok(list.slice(0, -added.length).includes(k), `${name} に ${k} が残っていない`);
  }
});
