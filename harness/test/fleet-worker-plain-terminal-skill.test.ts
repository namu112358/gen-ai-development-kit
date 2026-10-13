// Issue #1028：hq の worker として動く fleet が入れ子で拒まれたとき、素の Orca の端末で pick.ts の prefix を付けて ship を起こす手順を、
// support/skill-text.ts の構造の表で確かめる。fleet の skill の節「Orca の worker で ship を動かすとき」の手順7に素の端末の方式
// （terminal create → terminal send の順、prefix、/ship、質問はタブで人に直接 AskUserQuestion、status・depth）、手順3に素の端末の行を
// 同時の数に数え settle していない行の Issue を起こさないこと、手順6に素の端末の行がある間の待ち方、節「Orca の worker として動くとき」の
// 手順2に素の端末への分かれ道があることを見る。語句は要点ごとに少なく絞る。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems, type SkillSpec } from './support/skill-text.ts';

const SHIP_WORKER = '## Orca の worker で ship を動かすとき';

/** fleet の skill の、素の端末で ship を起こす方式の表 */
const PLAIN_TERMINAL_SPEC: SkillSpec = {
  path: '.claude/skills/fleet/references/orca-ship-worker.md',
  parts: [
    {
      section: SHIP_WORKER,
      step: 7,
      words: ['ORCA terminal create', 'ORCA terminal send', 'prefix', '/ship', 'AskUserQuestion', 'status', 'depth'],
      order: ['ORCA terminal create', 'ORCA terminal send'],
    },
    { section: SHIP_WORKER, step: 3, words: ['素の端末', 'settle'] },
    { section: SHIP_WORKER, step: 6, words: ['素の端末', '--timeout-ms', 'fleet-status --watch'] },
  ],
};

/** fleet の skill の、hq の worker として動くときの分かれ道の表 */
const AS_WORKER_SPEC: SkillSpec = {
  path: '.claude/skills/fleet/references/as-worker.md',
  parts: [{ section: '## Orca の worker として動くとき', step: 2, words: ['素の端末'] }],
};

test('fleet の skill：入れ子で拒まれたら素の端末で prefix を付けて /ship を起こし、質問はタブで人に聞き、同時の数に数えて待つ', () => {
  assert.deepEqual(skillProblems(PLAIN_TERMINAL_SPEC), []);
});

test('fleet の skill：hq の worker として動くとき、手順2に素の端末への分かれ道がある', () => {
  assert.deepEqual(skillProblems(AS_WORKER_SPEC), []);
});
