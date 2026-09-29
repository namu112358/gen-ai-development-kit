// Issue #257：hook の入口（.claude/hooks/run.mjs）が Node の版（24 未満か）を確かめ、足りなければ guard は止める側・session-env は知らせる側に倒すか。24 以上では今までどおり hook の main を動かすか
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..', '..');
const RUN = join(root, '.claude', 'hooks', 'run.mjs');

type HookName = 'guard' | 'session-env';
interface HookModule { main: () => Promise<void> | void }
interface RunResult { output: string }
interface RunModule {
  nodeMajorOk: (version: string) => boolean;
  hookFor: (arg: string) => HookName | null;
  failOutput: (hook: HookName, reason: string) => string;
  run: (opts: { version: string; hook: HookName; load: () => Promise<HookModule> }) => Promise<RunResult>;
}

/** run.mjs は型検査の対象外（tsconfig の include は harness 配下の .ts だけ）なので、使う形だけを型にして読む */
async function loadRun(): Promise<RunModule> {
  return (await import(pathToFileURL(RUN).href)) as RunModule;
}

interface DenyOutput { hookSpecificOutput?: { hookEventName?: unknown; permissionDecision?: unknown; permissionDecisionReason?: unknown } }
interface SessionOutput { systemMessage?: unknown; hookSpecificOutput?: { hookEventName?: unknown; additionalContext?: unknown; permissionDecision?: unknown } }

// ---- 版の判定 ----

test('nodeMajorOk：major が 24 以上なら true、24 未満・空・読めない版は false（先頭の v は許す）', async () => {
  const { nodeMajorOk } = await loadRun();
  for (const v of ['24.0.0', '24.11.1', '25.1.0', 'v24.1.0', '30.0.0']) assert.equal(nodeMajorOk(v), true, v);
  for (const v of ['22.12.0', '23.11.0', 'v22.0.0', '18.20.4', '', 'abc', 'v', '.24.0']) assert.equal(nodeMajorOk(v), false, JSON.stringify(v));
});

// ---- 失敗のときの出力 ----

test('failOutput：guard は PreToolUse の deny と理由を出す', async () => {
  const { failOutput } = await loadRun();
  const out = JSON.parse(failOutput('guard', 'Node 22.12.0 は古い')) as DenyOutput;
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Node 22.12.0 は古い' },
  });
});

test('failOutput：session-env は systemMessage と SessionStart の additionalContext を出し、permissionDecision を持たない', async () => {
  const { failOutput } = await loadRun();
  const out = JSON.parse(failOutput('session-env', 'Node 22.12.0 は古い')) as SessionOutput;
  assert.deepEqual(out, {
    systemMessage: 'Node 22.12.0 は古い',
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Node 22.12.0 は古い' },
  });
});

// ---- 引数の許可の一覧 ----

test('hookFor：basename が guard.ts・session-env.ts のものだけを受け付ける', async () => {
  const { hookFor } = await loadRun();
  assert.equal(hookFor('guard.ts'), 'guard');
  assert.equal(hookFor('.claude/hooks/guard.ts'), 'guard');
  assert.equal(hookFor(join(root, '.claude', 'hooks', 'guard.ts')), 'guard');
  assert.equal(hookFor('session-env.ts'), 'session-env');
  assert.equal(hookFor(join(root, '.claude', 'hooks', 'session-env.ts')), 'session-env');
  for (const arg of ['', '../x.ts', 'other.ts', 'run.mjs', 'guard', 'guard.js', 'guard.ts.bak', 'x/guard.tsx', 'session-env']) {
    assert.equal(hookFor(arg), null, JSON.stringify(arg));
  }
});

// ---- run ----

test('run：版が足りないと load を呼ばず、guard では版を含む理由の deny を出す', async () => {
  const { run } = await loadRun();
  let loads = 0;
  const r = await run({ version: '22.12.0', hook: 'guard', load: async () => { loads++; return { main: () => {} }; } });
  assert.equal(loads, 0, 'load を呼ばない');
  const out = JSON.parse(r.output) as DenyOutput;
  assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput?.permissionDecisionReason;
  assert.ok(typeof reason === 'string' && reason.includes('22.12.0'), `理由に版が入る: ${String(reason)}`);
});

test('run：版が足りないと load を呼ばず、session-env では版を含む systemMessage と additionalContext を出す', async () => {
  const { run } = await loadRun();
  let loads = 0;
  const r = await run({ version: '23.11.0', hook: 'session-env', load: async () => { loads++; return { main: () => {} }; } });
  assert.equal(loads, 0, 'load を呼ばない');
  const out = JSON.parse(r.output) as SessionOutput;
  assert.ok(typeof out.systemMessage === 'string' && out.systemMessage.includes('23.11.0'), `systemMessage: ${String(out.systemMessage)}`);
  assert.equal(out.hookSpecificOutput?.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput?.additionalContext;
  assert.ok(typeof ctx === 'string' && ctx.includes('23.11.0'), `additionalContext: ${String(ctx)}`);
  assert.equal(out.hookSpecificOutput?.permissionDecision, undefined);
});

test('run：load が例外を投げたら failOutput を出す（guard は deny、session-env は知らせる）', async () => {
  const { run } = await loadRun();
  const g = await run({ version: '24.1.0', hook: 'guard', load: async () => { throw new SyntaxError('読めない構文'); } });
  assert.equal((JSON.parse(g.output) as DenyOutput).hookSpecificOutput?.permissionDecision, 'deny');
  const s = await run({ version: '24.1.0', hook: 'session-env', load: async () => { throw new Error('読めない'); } });
  const so = JSON.parse(s.output) as SessionOutput;
  assert.ok(typeof so.systemMessage === 'string' && so.systemMessage.length > 0);
  assert.equal(so.hookSpecificOutput?.hookEventName, 'SessionStart');
});

test('run：main が例外を投げたら failOutput を出す', async () => {
  const { run } = await loadRun();
  const g = await run({ version: '24.1.0', hook: 'guard', load: async () => ({ main: async () => { throw new Error('途中で失敗'); } }) });
  assert.equal((JSON.parse(g.output) as DenyOutput).hookSpecificOutput?.permissionDecision, 'deny');
});

test('run：版が足りれば load して main を呼び、output は空', async () => {
  const { run } = await loadRun();
  for (const hook of ['guard', 'session-env'] as const) {
    let loads = 0;
    let mains = 0;
    const r = await run({ version: '24.0.0', hook, load: async () => { loads++; return { main: async () => { mains++; } }; } });
    assert.equal(loads, 1, `${hook}: load を1回呼ぶ`);
    assert.equal(mains, 1, `${hook}: main を1回呼ぶ`);
    assert.equal(r.output, '', `${hook}: 何も出さない`);
  }
});

// ---- 子プロセス（今の Node で run.mjs を通して hook を動かす） ----

function spawnRun(args: string[], input: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [RUN, ...args], { cwd: root, input, encoding: 'utf8', env });
}

const bashInput = (command: string): string =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command }, hook_event_name: 'PreToolUse', cwd: root });

test('子プロセス：run.mjs 経由の guard は main への push を deny し、通してよい入力では何も出さない', () => {
  for (const guardArg of [join(root, '.claude', 'hooks', 'guard.ts'), '.claude/hooks/guard.ts']) {
    for (const cmd of ['git push origin HEAD:main', 'gh pr merge 1']) {
      const r = spawnRun([guardArg], bashInput(cmd));
      assert.equal(r.status, 0, `${cmd}: exit code（stderr: ${r.stderr}）`);
      const out = JSON.parse(r.stdout) as DenyOutput;
      assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse', cmd);
      assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', cmd);
      const reason = out.hookSpecificOutput?.permissionDecisionReason;
      assert.ok(typeof reason === 'string' && reason.length > 0, `${cmd}: 理由が空`);
    }
    const ok = spawnRun([guardArg], bashInput('ls'));
    assert.equal(ok.status, 0, `ls: exit code（stderr: ${ok.stderr}）`);
    assert.equal(ok.stdout.trim(), '', 'ls は何も出さない');
  }
});

test('子プロセス：run.mjs 経由の session-env は export AGENT_HARNESS_SESSION=<id> を CLAUDE_ENV_FILE に書く', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-run-'));
  try {
    const file = join(dir, 'env.sh');
    writeFileSync(file, 'export EXISTING=1\n');
    const env = { ...process.env };
    delete env.AGENT_HARNESS_SESSION;
    delete env.CLAUDE_CODE_REMOTE_SESSION_ID;
    env.CLAUDE_ENV_FILE = file;
    const input = JSON.stringify({ session_id: 'abc-123', hook_event_name: 'SessionStart' });
    const r = spawnRun([join(root, '.claude', 'hooks', 'session-env.ts')], input, env);
    assert.equal(r.status, 0, r.stderr);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /^export AGENT_HARNESS_SESSION=(['"]?)abc-123\1$/m);
    assert.ok(content.startsWith('export EXISTING=1\n'), '追記であり、既存の行を消さない');
    assert.ok(!r.stdout.includes('systemMessage'), `版が足りるときは知らせない: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('子プロセス：許可の一覧に無い引数・引数なしでは exit 2 で理由を stderr に書く', () => {
  for (const args of [['other.ts'], ['../x.ts'], [join(root, 'harness', 'scripts', 'agent.ts')], []]) {
    const r = spawnRun(args, bashInput('ls'));
    assert.equal(r.status, 2, `${JSON.stringify(args)}: exit code（stdout: ${r.stdout}）`);
    assert.ok(r.stderr.trim().length > 0, `${JSON.stringify(args)}: 理由が空`);
  }
});

// ---- settings.json ----

interface HookEntry { matcher?: string; hooks?: Array<{ type?: string; command?: string }> }
interface Settings { hooks?: { PreToolUse?: HookEntry[]; SessionStart?: HookEntry[] } }

function commands(entries: HookEntry[] | undefined): string[] {
  const out: string[] = [];
  for (const e of entries ?? []) {
    for (const h of e.hooks ?? []) if (h.type === 'command' && typeof h.command === 'string') out.push(h.command);
  }
  return out;
}

function assertThroughRun(cmds: string[], hookPath: string): void {
  const hits = cmds.filter((c) => c.includes(hookPath));
  assert.ok(hits.length > 0, `${hookPath} の hook がありません`);
  for (const c of hits) {
    const at = c.indexOf('.claude/hooks/run.mjs');
    assert.ok(at >= 0, `run.mjs を通していない: ${c}`);
    assert.ok(at < c.indexOf(hookPath), `${hookPath} は run.mjs の引数: ${c}`);
  }
}

test('.claude/settings.json の PreToolUse・SessionStart の command は run.mjs を通して guard.ts・session-env.ts を呼ぶ', () => {
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings;
  assertThroughRun(commands(settings.hooks?.PreToolUse?.filter((e) => e.matcher === 'Bash|mcp__.*')), '.claude/hooks/guard.ts');
  assertThroughRun(commands(settings.hooks?.SessionStart), '.claude/hooks/session-env.ts');
});
