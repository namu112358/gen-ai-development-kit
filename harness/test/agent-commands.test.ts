// Issue #313：agent.ts のサブコマンドを harness/scripts/agent/commands/ に分け、agent.ts は loadCommands で読み込んで名前で振り分けるだけにする。
// 分ける前と同じ31件の名前・重複の拒否・.ts だけを読むこと・入口がコマンドの一覧を持たないこと・使い方の出力と終了コードを確かめる。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const agentPath = join(root, 'harness', 'scripts', 'agent.ts');

/** cli.ts は import したときに harness.config.json を読むので、ほかのテストを巻き込まないよう使うときだけ読み込む */
const loadCli = () => import('../scripts/agent/cli.ts');

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'agent-commands-'));
  tmpDirs.push(d);
  return d;
}
const commandFile = (...names: string[]): string =>
  `export const commands = [${names.map((n) => `{ name: ${JSON.stringify(n)}, run() {} }`).join(', ')}];\n`;

/** 分ける前の agent.ts が持っていたサブコマンドの名前 */
const BEFORE_SPLIT = [
  'arch-review-drafts',
  'arch-review-range',
  'arch-review-record',
  'block',
  'check',
  'claim',
  'compose-verdict',
  'critic-input',
  'ensure-claim',
  'fleet-status',
  'footer',
  'judge-input',
  'label-audit',
  'post-decision',
  'post-plan',
  'post-verdict',
  'qa-retro-data',
  'queue',
  'release',
  'render-block',
  'render-claim',
  'render-metrics',
  'render-plan',
  'render-verdict',
  'scope-check',
  'session-url',
  'show-plan',
  'usage',
  'wait',
  'worktree',
  'worktree-remove',
];

/** 分けた後に commands/ に足したサブコマンドの名前（step は Issue #306、harness-drift は Issue #199） */
const ADDED_AFTER_SPLIT = ['step', 'harness-drift'];

test('loadCommands(COMMANDS_DIR) の名前は分ける前の31件と、分けた後に足したものとちょうど同じ', async () => {
  const { loadCommands, COMMANDS_DIR } = await loadCli();
  const commands = await loadCommands(COMMANDS_DIR);
  assert.equal(BEFORE_SPLIT.length, 31);
  assert.deepEqual([...commands.keys()].sort(), [...BEFORE_SPLIT, ...ADDED_AFTER_SPLIT].sort());
  for (const [name, cmd] of commands) {
    assert.equal(cmd.name, name);
    assert.equal(typeof cmd.run, 'function', `${name} に run がありません`);
  }
});

test('同じ名前のコマンドが2つのファイルにあると、loadCommands は重複の名前を含む Error で拒否する', async () => {
  const { loadCommands } = await loadCli();
  const dir = tempDir();
  writeFileSync(join(dir, 'a.ts'), commandFile('dup-cmd', 'only-a'));
  writeFileSync(join(dir, 'b.ts'), commandFile('dup-cmd'));
  await assert.rejects(loadCommands(dir), (e: unknown) => {
    assert.ok(e instanceof Error);
    assert.ok(e.message.includes('dup-cmd'), e.message);
    return true;
  });
});

test('loadCommands は .ts だけを読み、README.md などは読まない', async () => {
  const { loadCommands } = await loadCli();
  const dir = tempDir();
  writeFileSync(join(dir, 'README.md'), '# commands\n\nexport const commands = [{ name: "from-readme", run() {} }];\n');
  writeFileSync(join(dir, 'one.ts'), commandFile('only-ts'));
  const commands = await loadCommands(dir);
  assert.deepEqual([...commands.keys()], ['only-ts']);
});

test('agent.ts は入口だけで、コマンドの名前を持たず、loadCommands と COMMANDS_DIR で振り分ける', () => {
  const src = readFileSync(agentPath, 'utf8');
  // 使い方のコメント（node harness/scripts/agent.ts ...）はコマンド名を含むので除いて調べる
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes("case '"), 'agent.ts に case の振り分けが残っています');
  for (const name of BEFORE_SPLIT) {
    for (const q of ["'", '"', '`']) {
      assert.ok(!code.includes(`${q}${name}${q}`), `agent.ts にコマンド名 ${q}${name}${q} があります`);
    }
  }
  assert.match(code, /\bloadCommands\b/);
  assert.match(code, /\bCOMMANDS_DIR\b/);
});

function runAgent(args: string[], envPatch: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'owner/repo' };
  for (const [k, v] of Object.entries(envPatch)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return spawnSync(process.execPath, [agentPath, ...args], { cwd: root, encoding: 'utf8', env });
}

test('引数なし・知らないコマンドは、標準エラーに使い方の案内を出して終了コード 1', () => {
  for (const args of [[], ['no-such-command']]) {
    const r = runAgent(args);
    assert.equal(r.status, 1, `${JSON.stringify(args)}: ${r.stderr}`);
    assert.ok(r.stderr.includes('usage: see header of harness/scripts/agent.ts'), `${JSON.stringify(args)}: ${r.stderr}`);
  }
});

test('GitHub を使わない session-url は、セッションが無ければ (none) を出して終了コード 0', () => {
  const r = runAgent(['session-url'], { CLAUDE_CODE_REMOTE_SESSION_ID: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '(none)');
});
