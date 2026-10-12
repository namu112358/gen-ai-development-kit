// Issue #744：plan-critic の定義に基準を示さない「厳しめ」が無く、must を定義の基準（must の箇条と、観点で revise・must にすると書いたもの）に当たるものだけにし、must の箇条と重しの文を保つ（support/skill-text.ts の構造の表で確かめる）。
// `## 出力` の節の「推奨だけで `revise` にしない」は plan-critique.test.ts と重なるが、`## 出力` の節に残ることを固定するために残す。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems } from './support/skill-text.ts';

test('plan-critic の定義に「厳しめ」が無く、must を定義の基準に当たる指摘だけにし、must の箇条と重しの文が残る', () => {
  const problems = skillProblems({
    path: '.claude/agents/plan-critic.md',
    words: [
      '観点で `revise`・`must` にすると書いたもの',
      '観点2（Merge 後にしか確かめられない AC の確かめ方が無い）は「AC を確かめられない」に',
      '見落とさずに `must` にし',
      '当たらない指摘は `should` にする',
      'スタイルや好みの違いだけで revise にしない',
    ],
    parts: [
      { absent: ['厳しめ'] },
      {
        section: '## 出力',
        words: [
          '- `must`（必須）：要件との食い違い、正しい入力・出力を壊す、安全を損なう、AC を確かめられない、触るファイルの漏れ、判断が実装に残っている（観点7）。',
          '推奨だけで `revise` にしない',
        ],
      },
    ],
  });
  assert.deepEqual(problems, []);
});
