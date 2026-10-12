// 受け入れた AC の変更の節を、見出しの文が「AC の変更の提案」で始まるものから取る（途中に含むだけの見出しは選ばない）（Issue #891、harness/lib/accepted-ac-change.ts）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acChangeProposal } from '../lib/accepted-ac-change.ts';

const MAPPING_LINE = '- AC1 は harness/lib/a.ts の変更で満たす';
const PROPOSAL_LINE = '- AC2 を「judge が照らす AC に受け入れた変更を含める」に変える';

test('AC の変更の提案の見出し：先に言葉を途中に含む見出しがあっても、「AC の変更の提案」で始まる見出しの節を取る', () => {
  const body = [
    '## 計画',
    '',
    '### AC ごとの対応（案 A。下の「AC の変更の提案」を受け入れた形）',
    MAPPING_LINE,
    '',
    '### AC の変更の提案（人が外すまで計画ゲートで止まる）',
    PROPOSAL_LINE,
    '',
    '### 触るファイル',
    '- harness/lib/a.ts',
  ].join('\n');
  const got = acChangeProposal(body);
  assert.ok(got?.includes(PROPOSAL_LINE), String(got));
  assert.ok(!got!.includes(MAPPING_LINE), got!);
});

test('AC の変更の提案の見出し：「AC の変更の提案」で始まる見出しが無ければ（途中に含む見出しだけでも）節を取らない', () => {
  const body = [
    '## 計画',
    '',
    '### AC ごとの対応（案 A。下の「AC の変更の提案」を受け入れた形）',
    MAPPING_LINE,
    '',
    '### 触るファイル',
    '- harness/lib/a.ts',
  ].join('\n');
  assert.equal(acChangeProposal(body), null);
});
