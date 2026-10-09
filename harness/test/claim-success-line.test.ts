// Issue #467：agent.ts claim が成功したときも、番号・段階・session の1行（claimedLine）を出す
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { shortSession } from '../lib/blocks.ts';
import { claimedLine } from '../lib/claim.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
/** CLAUDE_CODE_REMOTE_SESSION_ID から作る形（agent.ts の sessionUrl） */
const CLOUD = 'https://claude.ai/code/session_01ABCDEFxyz';

test('claimedLine は番号・段階・session の短い形を1行で返す', () => {
  const cases: { stage: Parameters<typeof claimedLine>[1]; session: string; expected: string }[] = [
    { stage: 'plan', session: SESSION, expected: '#467: 着手を宣言しました（段階 plan・session 3f2a9c1e）' },
    { stage: undefined, session: SESSION, expected: '#467: 着手を宣言しました（段階 なし・session 3f2a9c1e）' },
    { stage: 'implement', session: CLOUD, expected: `#467: 着手を宣言しました（段階 implement・session ${shortSession(CLOUD)}）` },
  ];
  for (const c of cases) {
    const line = claimedLine(467, c.stage, c.session);
    assert.equal(line, c.expected);
    assert.ok(!line.includes('\n'), `改行を含まない: ${JSON.stringify(line)}`);
  }
  // URL 形の session は URL のまま出さず、短い形にする
  assert.equal(shortSession(CLOUD), '01ABCDEF');
});

test('claim コマンドは失敗の fail([r.error]) の後で claimedLine を console.log する', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'scripts', 'agent', 'commands', 'claim.ts'), 'utf8');
  const failAt = src.indexOf('fail([r.error])');
  assert.ok(failAt >= 0, 'claim コマンドに fail([r.error]) がある');
  const logAt = src.indexOf('console.log(claimedLine(', failAt);
  assert.ok(logAt > failAt, 'fail([r.error]) の後に console.log(claimedLine( が来る');
  const releaseAt = src.indexOf('async function release');
  assert.ok(releaseAt < 0 || logAt < releaseAt, 'claimedLine の出力は claim() の中にある（release より前）');
});
