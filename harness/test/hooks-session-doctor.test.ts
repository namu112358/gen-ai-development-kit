// Issue #834：SessionStart の hook（.claude/hooks/session-env.ts）が、startup でだけ前提の確かめ（session-doctor）の行を Orca の知らせと1つの JSON にまとめて出すことを確かめる。
// 既定ブランチの古さは clone の harness.config.json の defaultBranch（main）で見る（Issue #866）。
// resume・clear・compact・Routine では確かめず、どの場合も exit 0 で AGENT_HARNESS_SESSION を書き、偽の gh の出力を漏らさず、git の子に画面を出さない env を渡すこと、
// 確かめの読み込みが投げても行が無いだけなことも見る。砂場の bare の origin と PATH の先頭の偽の gh・git で動かし、本物の gh・ネットワークを呼ばない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';

import * as hook from '../../.claude/hooks/session-env.ts';

const HOOK = join(import.meta.dirname, '..', '..', '.claude', 'hooks', 'session-env.ts');
const SKIP = process.platform === 'win32' ? '偽の gh・git（sh）が Windows では動かない' : false;
const SESSION_ID = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const TOKEN = 'gho_FAKE0123456789abcdefTOKEN';
const input = (source: string): string => JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'SessionStart', source });
const exportLine = new RegExp(`^export AGENT_HARNESS_SESSION=(['"]?)${SESSION_ID}\\1$`, 'm');

/** 一時ディレクトリに、bare の origin と main を1つ戻した clone（手元の既定ブランチ main が origin より古い。defaultBranch が main の harness.config.json を未追跡で置く）、名義の無い git の設定、偽の gh・git を置く */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'session-doctor-'));
  const [home, bin, origin, clone, work] = ['home', 'bin', 'origin.git', 'clone', 'work'].map((p) => join(dir, p)) as [string, string, string, string, string];
  for (const d of [home, bin, work]) mkdirSync(d);
  const gitConfig = join(dir, 'gitconfig');
  writeFileSync(gitConfig, '');
  const gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git(dir, 'init', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-b', 'main', clone);
  git(clone, 'remote', 'add', 'origin', origin);
  git(clone, 'commit', '--allow-empty', '-m', 'one');
  git(clone, 'commit', '--allow-empty', '-m', 'two');
  git(clone, 'push', 'origin', 'main');
  git(clone, 'reset', '--hard', 'HEAD~1');
  // コミットしない（main の SHA と古さの関係を変えない）
  writeFileSync(join(clone, 'harness.config.json'), JSON.stringify({ defaultBranch: 'main' }));

  const log = join(dir, 'calls.log');
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho gh >> '${log}'\necho ${TOKEN}\necho ${TOKEN} >&2\nexit 1\n`);
  writeFileSync(
    join(bin, 'git'),
    `#!/bin/sh\necho "git $1 TP=$GIT_TERMINAL_PROMPT GCM=$GCM_INTERACTIVE ASKPASS=$SSH_ASKPASS_REQUIRE LAZY=$GIT_NO_LAZY_FETCH" >> '${log}'\nexec '${realGit}' "$@"\n`,
  );
  for (const f of ['gh', 'git']) chmodSync(join(bin, f), 0o755);
  const envFile = join(home, 'env.sh');
  writeFileSync(envFile, '');
  return { dir, home, bin, clone, work, gitConfig, log, envFile };
}
type Sandbox = ReturnType<typeof makeSandbox>;

/** hooks-session-orca.test.ts の hookEnv と同じく、実行する環境で結果が変わる変数を消してから渡す */
function runHook(sb: Sandbox, source: string, extra: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^path$/i.test(k) || k.startsWith('ORCA_') || k.startsWith('GIT_')) continue;
    if (['CLAUDE_CODE_REMOTE_SESSION_ID', 'AGENT_HARNESS_SESSION', 'CLAUDE_ENV_FILE', 'CLAUDE_PROJECT_DIR', 'WSL_DISTRO_NAME', 'WSL_INTEROP'].includes(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    PATH: [sb.bin, dirname(process.execPath)].join(delimiter),
    HOME: sb.home,
    GIT_CONFIG_GLOBAL: sb.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    CLAUDE_ENV_FILE: sb.envFile,
    CLAUDE_PROJECT_DIR: sb.clone,
    AGENT_HARNESS_SESSION_DOCTOR: '1',
    ...extra,
  });
  writeFileSync(sb.envFile, '');
  rmSync(sb.log, { force: true });
  const r = spawnSync(process.execPath, [HOOK], { cwd: sb.work, input: input(source), encoding: 'utf8', env, timeout: 30_000 });
  return { ...r, envContent: readFileSync(sb.envFile, 'utf8'), calls: existsSync(sb.log) ? readFileSync(sb.log, 'utf8').split('\n').filter(Boolean) : [] };
}

test('startup：Orca の知らせと、git の名義・既定ブランチの古さ・gh の認証の行が1つの JSON に入り、gh の出力は漏れず、git の子に画面を出さない env が渡る', { skip: SKIP }, () => {
  const sb = makeSandbox();
  try {
    const r = runHook(sb, 'startup');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.envContent, exportLine);
    assert.equal(r.stdout.trim().split('\n').length, 1, `JSON は1回だけ: ${r.stdout}`);
    const out = JSON.parse(r.stdout) as { systemMessage: string; hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    for (const [name, text] of [['systemMessage', out.systemMessage], ['additionalContext', out.hookSpecificOutput.additionalContext]] as const) {
      for (const part of ['docs/setup.md の節11', 'git の名義', '手元の既定ブランチ（main）が origin より古い', 'gh の認証']) {
        assert.ok(text.includes(part), `${name} に「${part}」が無い: ${text}`);
      }
      assert.ok(!text.includes('Orca の CLI が見つかりません'), `${name}：Orca の知らせを出したのに確かめの Orca の行が重なった`);
      assert.equal(text.split('AGENT_HARNESS_SESSION_DOCTOR=0').length - 1, 1, `${name}：止め方の添え書きは1回だけ`);
    }
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'gh の出力が漏れた');
    assert.ok(r.calls.includes('gh'), '偽の gh が呼ばれていない');
    const lsRemote = r.calls.filter((c) => c.startsWith('git ls-remote '));
    assert.ok(lsRemote.length > 0, 'ls-remote が呼ばれていない');
    for (const c of lsRemote) for (const v of ['TP=0', 'GCM=never', 'ASKPASS=never']) assert.ok(c.includes(v), `ls-remote に ${v} が無い: ${c}`);
    const config = r.calls.filter((c) => c.startsWith('git config '));
    assert.ok(config.length > 0, '同期の git（config）が呼ばれていない');
    for (const c of config) for (const v of ['TP=0', 'LAZY=1']) assert.ok(c.includes(v), `同期の git に ${v} が無い: ${c}`);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('resume・clear・compact・Routine では確かめず何も出さず、exit 0 で AGENT_HARNESS_SESSION を書き、gh を呼ばない', { skip: SKIP }, () => {
  const sb = makeSandbox();
  try {
    const cases: [string, string, Record<string, string>][] = [
      ['resume', 'resume', {}],
      ['clear', 'clear', {}],
      ['compact', 'compact', {}],
      ['Routine', 'startup', { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_abc' }],
    ];
    for (const [label, source, extra] of cases) {
      const r = runHook(sb, source, { ORCA_CLI_COMMAND: 'orca-ide', ...extra });
      assert.equal(r.status, 0, `${label}: ${r.stderr}`);
      assert.equal(r.stdout.trim(), '', label);
      assert.match(r.envContent, exportLine, label);
      assert.ok(!r.calls.includes('gh'), `${label}: gh が呼ばれた`);
    }
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test('doctorLines は読み込みが投げると空、止める条件では読み込まずに空。mergeNotice は行が無ければ知らせのまま、行だけなら行と添え書きで形を作る', async () => {
  const on = { CLAUDE_PROJECT_DIR: '/x', AGENT_HARNESS_SESSION_DOCTOR: '1' };
  assert.deepEqual(await hook.doctorLines(input('startup'), on, false, async () => { throw new Error('load'); }), []);
  const skips: [string, string, Record<string, string | undefined>][] = [
    ['AGENT_HARNESS_SESSION_DOCTOR=0', input('startup'), { ...on, AGENT_HARNESS_SESSION_DOCTOR: '0' }],
    ['CLAUDE_PROJECT_DIR なし', input('startup'), { AGENT_HARNESS_SESSION_DOCTOR: '1' }],
    ['resume', input('resume'), on],
    ['Routine', input('startup'), { ...on, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_x' }],
    ['JSON が壊れている', '{not json', on],
  ];
  for (const [label, raw, env] of skips) {
    let loaded = 0;
    const lines = await hook.doctorLines(raw, env, false, async () => { loaded++; throw new Error('load'); });
    assert.deepEqual(lines, [], label);
    assert.equal(loaded, 0, `${label}: 読み込んだ`);
  }

  const notice = hook.orcaNotice(input('startup'), { PATH: '/nowhere' }, () => false, 'linux');
  assert.ok(notice);
  assert.equal(hook.mergeNotice(null, []), null);
  assert.deepEqual(hook.mergeNotice(notice, []), notice);
  const only = hook.mergeNotice(null, ['行A', '行B']);
  assert.ok(only);
  assert.equal(only.hookSpecificOutput.hookEventName, 'SessionStart');
  for (const text of [only.systemMessage, only.hookSpecificOutput.additionalContext]) {
    assert.match(text, /行A\n行B/);
    assert.ok(text.includes('AGENT_HARNESS_SESSION_DOCTOR=0'), text);
  }
});
