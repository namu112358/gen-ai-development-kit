// Issue #409：hq がいない間の fleet の退行、hq の控えの置き場所と引き継ぎを書いた fleet・hq の skill に出る hq-state.ts のコマンドが、
// hq-state.ts の HQ_STATE_COMMANDS にあることを確かめる（コマンド名の実在）。skill・docs の語の有無は固定しない（#1007）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HQ_STATE_COMMANDS } from '../scripts/hq-state.ts';
import { skillText } from './support/skill-text.ts';

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const HQ_SKILL = '.claude/skills/hq/SKILL.md';

test('fleet・hq の skill に出る hq-state.ts のコマンドは、すべて HQ_STATE_COMMANDS にある', () => {
  const used = new Set<string>();
  for (const path of [FLEET_SKILL, HQ_SKILL]) {
    for (const m of skillText(path).matchAll(/hq-state\.ts\s+([a-z][a-z-]*)/g)) used.add(m[1]!);
  }
  assert.ok(used.size > 0, 'skill に hq-state.ts のコマンドがありません');
  const unknown = [...used].filter((c) => !HQ_STATE_COMMANDS.includes(c));
  assert.deepEqual(unknown, [], `HQ_STATE_COMMANDS に無いコマンド：${unknown.join('、')}`);
});
