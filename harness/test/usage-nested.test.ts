// Issue #243：入れ子のサブエージェント（fleet が動かす ship と、ship が動かす担当のサブエージェント）のトークンも usage の集計に含まれる。
// Claude Code は入れ子の2階層目の記録も、主の記録の `<sessionId>/subagents/` に平らに置く。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findSessionTranscriptsWithNote, projectTranscriptDir, summarizeUsage, totalTokens } from '../lib/usage.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-dddddddddddd';

const line = (id: string, model: string, input: number, output: number): string =>
  JSON.stringify({ type: 'assistant', message: { id, model, usage: { input_tokens: input, output_tokens: output } } });

/** dir に主の記録と、1階層目（ship）・2階層目（ship が動かした reviewer など）のサブエージェントの記録を置く */
function writeNested(dir: string): { main: string; ship: string; nested: string } {
  mkdirSync(join(dir, SESSION, 'subagents'), { recursive: true });
  const main = join(dir, `${SESSION}.jsonl`);
  const ship = join(dir, SESSION, 'subagents', 'agent-a1ship.jsonl');
  const nested = join(dir, SESSION, 'subagents', 'agent-b2reviewer.jsonl');
  writeFileSync(main, `${line('m1', 'claude-opus-5-5', 1000, 10)}\n`);
  writeFileSync(ship, `${line('s1', 'claude-opus-5-5', 200, 20)}\n${line('s2', 'claude-opus-5-5', 300, 30)}\n`);
  writeFileSync(nested, `${line('n1', 'claude-haiku-4-5', 40, 4)}\n`);
  writeFileSync(join(dir, SESSION, 'subagents', 'agent-a1ship.meta.json'), '{}');
  return { main, ship, nested };
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'usage-nested-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('findSessionTranscriptsWithNote：主の記録と、subagents/ の1階層目・2階層目の記録を全部返す', () => {
  withTemp((home) => {
    const cwd = '/work/repo';
    const t = writeNested(projectTranscriptDir(cwd, home));
    const r = findSessionTranscriptsWithNote(cwd, undefined, SESSION, home);
    assert.deepEqual(r, { files: [t.main, ...[t.ship, t.nested].sort()], bySession: true });
  });
});

test('集計：主・1階層目・2階層目のトークンを合計する', () => {
  withTemp((home) => {
    const cwd = '/work/repo';
    writeNested(projectTranscriptDir(cwd, home));
    const { files } = findSessionTranscriptsWithNote(cwd, undefined, SESSION, home);
    const summary = summarizeUsage(files.flatMap((f) => readFileSync(f, 'utf8').split('\n')));
    assert.equal(summary['claude-opus-5-5']!.input, 1500);
    assert.equal(summary['claude-haiku-4-5']!.input, 40, '2階層目のモデルが集計に出る');
    const total = totalTokens(summary);
    assert.equal(total.input, 1540);
    assert.equal(total.output, 64);
  });
});

test('agent.ts usage：入れ子の ship と担当のサブエージェントのトークンを集計に含める', () => {
  withTemp((home) => {
    const t = writeNested(projectTranscriptDir(root, home));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, AGENT_HARNESS_SESSION: SESSION };
    delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
    const r = spawnSync(process.execPath, ['harness/scripts/agent.ts', 'usage'], { cwd: root, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { files?: string[]; total?: { input: number; output: number } };
    assert.deepEqual(out.files, [t.main, ...[t.ship, t.nested].sort()]);
    assert.equal(out.total?.input, 1540);
    assert.equal(out.total?.output, 64);
  });
});
