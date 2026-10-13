// Issue #786：post-verdict の dry-run（harness/scripts/agent/commands/judge.ts の postVerdict と、コマンドの --dry-run）。
// (1) dryRun（postVerdict の opts と、コマンドの引数 --dry-run の両方）では、偽の GitHub に書き込み（POST）が無く、組み立てた本文が { dryRun: true, body } で出力に出る。
// (2) dryRun が無ければ今までどおり判定コメントを1件投稿する。
// (3) dryRun でも検査は緩めない：判定の PR 番号が違えば、書き込みも本文の出力も無く止まる（終了コード 2）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { CLAUDE_MARK, renderBlock } from '../lib/blocks.ts';
import { GitHub } from '../lib/github.ts';
import type { AgentCommand } from '../scripts/agent/cli.ts';
import { FakeGitHub, HEAD, pr, verdict } from './support/gate-fixtures.ts';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function verdictFile(prNumber = 5): string {
  const d = mkdtempSync(join(tmpdir(), 'judge-routine-dry-run-'));
  tmpDirs.push(d);
  const f = join(d, 'verdict.md');
  writeFileSync(f, `${CLAUDE_MARK}\n## 判定\n\n${renderBlock('agent-verdict', verdict({ pr: prNumber, headSha: HEAD }))}`);
  return f;
}

function world() {
  return new FakeGitHub()
    .on('GET', /\/pulls\/5$/, () => pr())
    .on('POST', /\/issues\/5\/comments$/, () => ({ id: 300, html_url: 'https://github.com/o/r/pull/5#issuecomment-300' }));
}

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadJudge = () => import('../scripts/agent/commands/judge.ts');

/** f を動かし、console.log の出力を返す。process.exit は投げる例外にする */
async function capture(t: TestContext, f: () => Promise<void>, logs: string[] = []): Promise<string[]> {
  const errors: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  t.mock.method(process, 'exit', (code?: number) => {
    throw new Error(`process.exit(${code}): ${errors.join('\n')}`);
  });
  try {
    await f();
  } finally {
    t.mock.restoreAll();
  }
  return logs;
}

test('dryRun（postVerdict の opts・コマンドの --dry-run）では書き込みが無く、組み立てた判定の本文が出力に出る', async (t) => {
  const mod = await loadJudge();
  const cmd = (mod.commands as AgentCommand[]).find((c) => c.name === 'post-verdict')!;
  const ways: { name: string; run: (fake: FakeGitHub, file: string) => Promise<void> }[] = [
    { name: 'postVerdict(..., { dryRun: true })', run: (fake, file) => mod.postVerdict(new GitHub(fake, 'o/r'), 5, file, { dryRun: true }) },
    { name: 'post-verdict 5 <file> --dry-run', run: async (fake, file) => void (await cmd.run(['5', file, '--dry-run'], { counter: null, gh: () => new GitHub(fake, 'o/r') })) },
    { name: 'post-verdict --dry-run 5 <file>', run: async (fake, file) => void (await cmd.run(['--dry-run', '5', file], { counter: null, gh: () => new GitHub(fake, 'o/r') })) },
  ];
  for (const w of ways) {
    const fake = world();
    const file = verdictFile();
    const logs = await capture(t, () => w.run(fake, file));
    assert.deepEqual(fake.writes(), [], w.name);
    assert.ok(fake.calls.every((c) => c.method === 'GET'), `${w.name}: GET 以外を呼んだ`);
    const out = JSON.parse(logs.at(-1)!);
    assert.equal(out.dryRun, true, w.name);
    assert.ok(String(out.body).includes('agent-verdict'), `${w.name}: 本文に判定のブロックが無い`);
    assert.ok(String(out.body).includes(HEAD), `${w.name}: 本文に判定した head が無い`);
  }
});

test('dryRun が無ければ今までどおり判定コメントを1件投稿する', async (t) => {
  const { postVerdict } = await loadJudge();
  const fake = world();
  const logs = await capture(t, () => postVerdict(new GitHub(fake, 'o/r'), 5, verdictFile()));
  const posts = fake.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 1);
  assert.match(posts[0]!.path, /\/issues\/5\/comments$/);
  assert.ok(String(posts[0]!.body.body).includes('agent-verdict'));
  assert.equal(JSON.parse(logs.at(-1)!).posted, 'https://github.com/o/r/pull/5#issuecomment-300');
});

test('dryRun でも判定の PR 番号が違えば、書き込みも本文の出力も無く止まる', async (t) => {
  const { postVerdict } = await loadJudge();
  const fake = world();
  const logs: string[] = [];
  await assert.rejects(capture(t, () => postVerdict(new GitHub(fake, 'o/r'), 5, verdictFile(6), { dryRun: true }), logs), /process\.exit\(2\)/);
  assert.deepEqual(fake.writes(), []);
  assert.deepEqual(logs, []);
});
