// Issue #235：Jev の確度が下限未満で付かなかった priority:*・area:* は、付き添いのセッションが判断して付けてよい。
// label-triage のコメント（renderLabelTriage）の文言がこの扱いと合っているかを確かめる。
// 規則・skill・docs・overview.html の語の有無は固定しない（#1007）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderLabelTriage, type JevLabelResult } from '../gates/label-apply.ts';
import type { TriageSummary } from '../lib/issue-triage.ts';

// ---- label-triage のコメントの文言 ----

test('renderLabelTriage：付けなかったものは「付き添いのセッションか人が付けてください」と書く', () => {
  const summary: TriageSummary = { type: ['feat', 0.9], area: ['docs', 0.4], priority: ['high', 0.5], acVerifiable: 0.9, requirementsClear: 0.9, warnings: [] };
  const results: JevLabelResult[] = [
    { question: 'priority', choice: 'high', probability: 0.5, label: 'priority:high', applied: false, reason: '確率 50% が下限 80% 未満' },
    { question: 'area', choice: 'docs', probability: 0.4, label: 'area:docs', applied: false, reason: '確率 40% が下限 80% 未満' },
  ];
  const body = renderLabelTriage(summary, results);
  assert.ok(body.includes('付けなかったもの（付き添いのセッションか人が付けてください）:'), `付けなかったものの見出しが新しい文言でない：\n${body}`);
  assert.ok(!body.includes('付けなかったもの（人が付けてください）'), '古い「人が付けてください」が残っている');
});
