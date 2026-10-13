// Issue #953：agent.ts の post-confirm（harness/scripts/agent/commands/confirm.ts）を、偽の GitHub（FakeGitHub）の上で run から動かして確かめる。
// (1) 書式の正しい確認事項で target が番号と同じなら、GET 以外の要求は POST /repos/o/r/issues/<番号>/comments の1件だけで（ラベル・本文・状態の API を呼ばない）、
//     本文は agent-confirm のフェンスを持ち、出力の posted は投稿したコメントの URL。
// (2) target が番号と違う・書式の誤り（stage より先の resume）・agent-confirm でないブロックは、終了コード 2 で止まり、GitHub を1回も呼ばない
//     （fail が process.exit(2) を呼ぶので、process.exit を投げる例外にして同じプロセスで確かめる）。
// 書式の細かい場合は harness/test/confirm-format.test.ts（lib）が確かめるので繰り返さない。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import type { AgentCommand } from '../scripts/agent/cli.ts';
import { GitHub } from '../lib/github.ts';
import { FakeGitHub } from './support/gate-fixtures.ts';

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadCommand = async () => {
  const mod = await import('../scripts/agent/commands/confirm.ts');
  const cmd = (mod.commands as AgentCommand[]).find((c) => c.name === 'post-confirm');
  assert.ok(cmd, 'post-confirm のコマンドが無い');
  return cmd;
};

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function writeFile(text: string): string {
  const d = mkdtempSync(join(tmpdir(), 'confirm-command-'));
  tmpDirs.push(d);
  const path = join(d, 'confirm.md');
  writeFileSync(path, text);
  return path;
}

const fence = (kind: string, value: unknown): string => ['```' + kind, JSON.stringify(value, null, 2), '```'].join('\n');

const confirmRaw = (patch: Record<string, unknown> = {}) => ({
  version: 1,
  target: 7,
  stage: 'judge',
  resume: 'implement',
  questions: [{ text: '既定を shadow にするか', why: '設定の既定は人の決定', choices: ['はい', 'いいえ'] }],
  holds: '答えがそろうまで実装を止める',
  ...patch,
});

const confirmFile = (patch: Record<string, unknown> = {}) => writeFile(['確認させてください。', '', fence('agent-confirm', confirmRaw(patch))].join('\n'));

const POSTED_URL = 'https://github.com/o/r/issues/7#issuecomment-500';

function world(): FakeGitHub {
  return new FakeGitHub().on('POST', /^\/repos\/o\/r\/issues\/\d+\/comments$/, () => ({ id: 500, html_url: POSTED_URL }));
}

/** run を動かす。process.exit は投げる例外にし、終了コードと出力を返す */
async function runPost(t: TestContext, fake: FakeGitHub, args: string[]): Promise<{ exitCode: number | null; logs: string[] }> {
  const cmd = await loadCommand();
  const logs: string[] = [];
  let exitCode: number | null = null;
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', (code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  });
  try {
    await cmd.run(args, { counter: null, gh: () => new GitHub(fake, 'o/r') });
  } catch (e) {
    if (exitCode === null) throw e;
  } finally {
    t.mock.restoreAll();
  }
  return { exitCode, logs };
}

test('post-confirm：書き込みは POST /issues/<番号>/comments の1件だけで、ラベルの操作が無い', async (t) => {
  const fake = world();
  const { exitCode, logs } = await runPost(t, fake, ['7', confirmFile()]);
  assert.equal(exitCode, null);

  const writes = fake.calls.filter((c) => c.method !== 'GET');
  assert.equal(writes.length, 1, JSON.stringify(writes.map((c) => `${c.method} ${c.path}`)));
  assert.equal(writes[0]!.method, 'POST');
  assert.equal(writes[0]!.path, '/repos/o/r/issues/7/comments');
  assert.ok(String(writes[0]!.body?.body).includes('```agent-confirm'), '本文に agent-confirm のフェンスが無い');
  assert.ok(!fake.calls.some((c) => c.path.includes('/labels')), 'ラベルの API を呼んだ');
  assert.ok(!fake.calls.some((c) => c.path === '/graphql'), 'GraphQL を呼んだ');

  const out = logs.at(-1);
  assert.ok(out !== undefined, '出力が無い');
  assert.equal(JSON.parse(out).posted, POSTED_URL);
});

test('post-confirm：target の食い違い・書式の誤り・agent-confirm でないブロックは終了コード 2 で止まり、GitHub を呼ばない', async (t) => {
  const cases: [string, string[]][] = [
    ['target（7）が番号（8）と違う', ['8', confirmFile()]],
    ['resume が stage より先', ['7', confirmFile({ stage: 'plan', resume: 'implement' })]],
    ['questions が空', ['7', confirmFile({ questions: [] })]],
    ['agent-decision のブロック', ['7', writeFile(fence('agent-decision', { version: 1, issue: 7, planCommentId: 80, answers: [] }))]],
  ];
  for (const [name, args] of cases) {
    const fake = world();
    const { exitCode } = await runPost(t, fake, args);
    assert.equal(exitCode, 2, name);
    assert.deepEqual(fake.calls, [], `${name}: GitHub を呼んだ`);
  }
});
