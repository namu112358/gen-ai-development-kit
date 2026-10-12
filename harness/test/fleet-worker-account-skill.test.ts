// Issue #822：fleet が Orca の worker で ship を起こすとき、使用量の低いアカウントで起こす手順を、support/skill-text.ts の構造の表で確かめる。
// fleet の skill の節「Orca の worker で ship を動かすとき」の手順4で、問い合わせ（probe.ts）→ 選ぶ（pick.ts）→ Claude の起動（terminal send）の順に
// 進み、picked・default・wait の扱い（前置き・リセットの時刻・宣言の解除）があること、手順8に全部 wait のときの一覧の扱いがあること、
// docs/setup.md の Orca の節に対応表の書式・設定ディレクトリの準備・問い合わせが haiku を呼ぶことがあることを見る。語句は要点ごとに少なく絞る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems, type SkillSpec } from './support/skill-text.ts';

const SHIP_WORKER = '## Orca の worker で ship を動かすとき';

/** fleet の skill の、worker を起こすアカウントの表 */
const FLEET_ACCOUNT_SPEC: SkillSpec = {
  path: '.claude/skills/fleet/SKILL.md',
  parts: [
    {
      section: SHIP_WORKER,
      step: 4,
      words: ['picked', 'default', 'wait', 'prefix', 'resetAt', 'release'],
      order: ['node harness/scripts/accounts/probe.ts', 'node harness/scripts/accounts/pick.ts', 'ORCA terminal send'],
    },
    { section: SHIP_WORKER, step: 8, words: ['wait', '全部'] },
  ],
};

/** docs/setup.md の Orca の節の表 */
const SETUP_ACCOUNT_SPEC: SkillSpec = {
  path: 'docs/setup.md',
  parts: [{ section: '## 11. Orca', words: ['accounts.json', 'threshold5h', 'configDir', 'haiku', 'CLAUDE_CODE_OAUTH_TOKEN'] }],
};

test('fleet の skill：worker を起こす前に問い合わせ → 選ぶの順に走らせ、picked・default・wait を扱い、全部 wait なら一覧に書く', () => {
  assert.deepEqual(skillProblems(FLEET_ACCOUNT_SPEC), []);
});

test('docs/setup.md の Orca の節：対応表の書式・設定ディレクトリの準備・問い合わせが haiku を呼ぶことを書く', () => {
  assert.deepEqual(skillProblems(SETUP_ACCOUNT_SPEC), []);
});
