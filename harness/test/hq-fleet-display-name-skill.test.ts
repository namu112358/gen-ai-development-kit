// Issue #591：hq が付ける fleet の表示名の #番号 の後ろを日本語の短い言葉にする（`fleet: #<Epic番号> <日本語の短い言葉>`）。
// hq の skill の手順4（起動）と、fleet の skill の worker の手順3・交代の手順4に新しい形があり、古い `<短い名前>` の形が
// 残っていないことを、support/skill-text.ts の構造の表で確かめる。語句は要点だけに絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems, type SkillSpec } from './support/skill-text.ts';

const NEW_FORM = 'fleet: #<Epic番号> <日本語の短い言葉>';
const OLD_FORM = 'fleet: #<Epic番号> <短い名前>';

/** hq の skill：手順4の --display-name と言葉の作り方（日本語・--label に同じ言葉） */
const HQ_DISPLAY_NAME_SPEC: SkillSpec = {
  path: '.claude/skills/hq/SKILL.md',
  parts: [
    { step: 4, words: [NEW_FORM, '日本語', '--label'] },
    { absent: [OLD_FORM] },
  ],
};

/** fleet の skill：worker の手順3（テーマの名前）と、交代の手順4（起こし直す端末の表示名） */
const FLEET_DISPLAY_NAME_SPEC: SkillSpec = {
  path: '.claude/skills/fleet/SKILL.md',
  parts: [
    { section: '## Orca の worker として動くとき', step: 3, words: [NEW_FORM] },
    { section: '## ハーネスが更新されたときの交代', step: 4, words: [NEW_FORM] },
    { absent: [OLD_FORM] },
  ],
};

test('fleet の表示名：hq の起動と fleet の交代が同じ `fleet: #<Epic番号> <日本語の短い言葉>` の形で、古い形が残らない（#591）', () => {
  const problems = [HQ_DISPLAY_NAME_SPEC, FLEET_DISPLAY_NAME_SPEC].flatMap((spec) => skillProblems(spec).map((p) => `${spec.path}：${p}`));
  assert.deepEqual(problems, []);
});
