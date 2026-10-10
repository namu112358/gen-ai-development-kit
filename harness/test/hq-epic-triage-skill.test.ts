// hq の手順8の Epic の案を人に聞く手順を、App の Epic の振り分けの結果を一覧に出す手順に置き換えた文を確かめる（Issue #566、Epic #436）。
// hq の skill・docs/operations.md の「Epic の振り分け」・intel の skill・overview.html を support/skill-text.ts の構造の表で見る。
// 語句は要点だけに絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillProblems } from './support/skill-text.ts';

test('hq の skill：手順8は Epic の案を人に聞かず、App の振り分けの結果を手順12の一覧に出す', () => {
  assert.deepEqual(
    skillProblems({
      path: '.claude/skills/hq/SKILL.md',
      parts: [
        // 手順2：承認した案の Epic の Issue の作成・sub-issues への付け足しをしない
        { step: 2, absent: ['承認した案だけ'] },
        // 手順8：ダッシュボードの節を読み、enforce のときだけ App が足す。hq は聞かず・足さず・作らない
        {
          step: 8,
          words: ['Epic に入っていない Issue', 'jev.epicTriage', 'enforce', '手順12の一覧に出す'],
          absent: ['承認した案だけ', '新しい Epic を」', 'intel に作らせ', 'gh issue create'],
        },
        // 手順12：Epic に入っていない Issue を一覧に出し、Epic の案は聞かない
        { step: 12, words: ['Epic に入っていない Issue'], absent: ['Epic の案'] },
      ],
    }),
    [],
  );
});

test('docs/operations.md：Epic の振り分けの規則と、下限を含む設定がある', () => {
  assert.deepEqual(
    skillProblems({
      path: 'docs/operations.md',
      parts: [
        {
          section: '### Epic の振り分け',
          words: ['jev.epicTriage', 'jev.epicTriagePerRun', 'jev.thresholds.epicProbability', 'jev.thresholds.epicMargin', 'shadow', 'enforce', 'added'],
        },
        // hq の見回しの行に、承認した案を hq が足す流れが残っていない
        { absent: ['承認した案だけ hq が足す'] },
      ],
    }),
    [],
  );
});

test('intel の skill と overview.html に、hq が Epic の案を人に聞く流れが残っていない', () => {
  assert.deepEqual(skillProblems({ path: '.claude/skills/intel/SKILL.md', parts: [{ absent: ['人の承認を添えて', 'Epic の案'] }] }), []);
  assert.deepEqual(skillProblems({ path: 'overview.html', parts: [{ absent: ['Epic の案'] }] }), []);
});
