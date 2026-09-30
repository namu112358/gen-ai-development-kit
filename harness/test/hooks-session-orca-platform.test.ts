// Issue #311：SessionStart の hook（.claude/hooks/session-env.ts）が、Orca の CLI が無いという知らせを環境（Windows・WSL・Linux・その他）で見分けて出すか。
// orcaEnvironment の判定、環境ごとに isExecutable に渡るパス（Windows は ';' 区切りの PATH と PATHEXT の orca、それ以外は ':' 区切りの orca-ide だけ）、
// 環境ごとの文面、どの環境でも ORCA_CLI_COMMAND・Routine・startup 以外では知らせないことを、platform と env を差し替えて直接呼んで確かめる
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as hook from '../../.claude/hooks/session-env.ts';

const NOTICE_REF = 'docs/setup.md の節11';
const SESSION_ID = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const input = (source?: string): string =>
  JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'SessionStart', ...(source === undefined ? {} : { source }) });

type Env = Record<string, string | undefined>;
const never = (): boolean => false;

/** isExecutable に渡ったパスを集める（すべて見つからない扱い） */
function collect(platform: string, env: Env): { seen: string[]; notice: ReturnType<typeof hook.orcaNotice> } {
  const seen: string[] = [];
  const notice = hook.orcaNotice(input('startup'), env, (p) => {
    seen.push(p);
    return false;
  }, platform);
  return { seen, notice };
}

/** systemMessage と additionalContext の両方 */
function texts(n: NonNullable<ReturnType<typeof hook.orcaNotice>>): string[] {
  return [n.systemMessage, n.hookSpecificOutput.additionalContext];
}

// ---- orcaEnvironment ----

test('orcaEnvironment：win32 は windows（WSL の変数があっても）', () => {
  assert.equal(hook.orcaEnvironment('win32', {}), 'windows');
  assert.equal(hook.orcaEnvironment('win32', { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop' }), 'windows');
});

test('orcaEnvironment：linux で WSL_DISTRO_NAME か WSL_INTEROP があれば wsl', () => {
  assert.equal(hook.orcaEnvironment('linux', { WSL_DISTRO_NAME: 'Ubuntu' }), 'wsl');
  assert.equal(hook.orcaEnvironment('linux', { WSL_INTEROP: '/run/WSL/1_interop' }), 'wsl');
  assert.equal(hook.orcaEnvironment('linux', { WSL_DISTRO_NAME: 'Ubuntu', WSL_INTEROP: '/run/WSL/1_interop' }), 'wsl');
});

test('orcaEnvironment：WSL の印の無い linux は linux', () => {
  assert.equal(hook.orcaEnvironment('linux', {}), 'linux');
  assert.equal(hook.orcaEnvironment('linux', { PATH: '/usr/bin' }), 'linux');
});

test('orcaEnvironment：darwin などそれ以外は other', () => {
  assert.equal(hook.orcaEnvironment('darwin', {}), 'other');
  assert.equal(hook.orcaEnvironment('freebsd', { WSL_DISTRO_NAME: 'Ubuntu' }), 'other');
});

// ---- Windows ----

test('windows：PATH の各ディレクトリ（" を外し、末尾の \\ を外す）に PATHEXT の各拡張子を付けた orca だけを、この順で探す', () => {
  const { seen, notice } = collect('win32', { PATH: 'C:\\a;"C:\\b\\"', PATHEXT: '.EXE;.CMD' });
  assert.deepEqual(seen, ['C:\\a\\orca.EXE', 'C:\\a\\orca.CMD', 'C:\\b\\orca.EXE', 'C:\\b\\orca.CMD']);
  assert.ok(notice, '見つからないのに null が返った');
});

test('windows：PATH の空の要素は飛ばし、末尾の / も外す', () => {
  const { seen } = collect('win32', { PATH: ';C:\\a\\;;C:/c/;', PATHEXT: '.EXE' });
  assert.deepEqual(seen, ['C:\\a\\orca.EXE', 'C:/c\\orca.EXE']);
});

test('windows：PATHEXT が無い・空なら .COM;.EXE;.BAT;.CMD を使う', () => {
  for (const PATHEXT of [undefined, '']) {
    const { seen } = collect('win32', { PATH: 'C:\\a', PATHEXT });
    assert.deepEqual(seen, ['C:\\a\\orca.COM', 'C:\\a\\orca.EXE', 'C:\\a\\orca.BAT', 'C:\\a\\orca.CMD'], `PATHEXT=${String(PATHEXT)}`);
  }
});

test('windows：どこかに PATHEXT 付きの orca があれば null', () => {
  const env = { PATH: 'C:\\a;"C:\\b\\"', PATHEXT: '.EXE;.CMD' };
  assert.equal(hook.orcaNotice(input('startup'), env, (p) => p === 'C:\\b\\orca.CMD', 'win32'), null);
  assert.equal(hook.orcaNotice(input('startup'), env, (p) => p === 'C:\\a\\orca.EXE', 'win32'), null);
});

test('windows：orca-ide は探さず、orca-ide があっても知らせる', () => {
  const { seen } = collect('win32', { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE' });
  for (const p of seen) assert.ok(!/orca-ide/i.test(p), `orca-ide を探した: ${p}`);
  const n = hook.orcaNotice(input('startup'), { PATH: 'C:\\a', PATHEXT: '.EXE' }, (p) => /orca-ide/i.test(p), 'win32');
  assert.ok(n, 'orca-ide を見つけたことにして null が返った');
});

test('windows：文面に「Windows」と orca が入り、orca-ide は入らない。節への案内がある', () => {
  const { notice } = collect('win32', { PATH: 'C:\\a', PATHEXT: '.EXE' });
  assert.ok(notice, 'null が返った');
  assert.equal(notice.hookSpecificOutput.hookEventName, 'SessionStart');
  for (const t of texts(notice)) {
    assert.ok(t.includes('Windows'), `「Windows」が無い: ${t}`);
    assert.ok(t.includes('orca'), `orca が無い: ${t}`);
    assert.ok(!t.includes('orca-ide'), `orca-ide が入っている: ${t}`);
    assert.ok(t.includes(NOTICE_REF), `「${NOTICE_REF}」が無い: ${t}`);
  }
});

// ---- WSL・Linux・その他 ----

const WSL_ENV: Env = { PATH: '/a:/b/', WSL_DISTRO_NAME: 'Ubuntu' };
const LINUX_ENV: Env = { PATH: '/a:/b/' };

test('wsl・linux・other：\':\' 区切りの PATH の各ディレクトリの orca-ide だけを探す（素の orca・PATHEXT は使わない）', () => {
  for (const [platform, env, label] of [
    ['linux', { ...WSL_ENV, PATHEXT: '.EXE' }, 'wsl'],
    ['linux', { ...LINUX_ENV, PATHEXT: '.EXE' }, 'linux'],
    ['darwin', { ...LINUX_ENV, PATHEXT: '.EXE' }, 'other'],
  ] as const) {
    const { seen, notice } = collect(platform, env);
    assert.deepEqual(seen, ['/a/orca-ide', '/b/orca-ide'], label);
    assert.ok(notice, `${label}: null が返った`);
  }
});

test('wsl・linux・other：orca-ide があれば null、素の orca だけなら知らせる', () => {
  for (const [platform, env, label] of [
    ['linux', WSL_ENV, 'wsl'],
    ['linux', LINUX_ENV, 'linux'],
    ['darwin', LINUX_ENV, 'other'],
  ] as const) {
    assert.equal(hook.orcaNotice(input('startup'), env, (p) => p === '/b/orca-ide', platform), null, label);
    assert.ok(hook.orcaNotice(input('startup'), env, (p) => /\/orca$/.test(p), platform), `${label}: 素の orca で null が返った`);
  }
});

test('wsl：文面に「WSL」「orca-ide」「ORCA_CLI_COMMAND」と節への案内がある（WSL_INTEROP だけでも）', () => {
  for (const env of [WSL_ENV, { PATH: '/a', WSL_INTEROP: '/run/WSL/1_interop' }]) {
    const n = hook.orcaNotice(input('startup'), env, never, 'linux');
    assert.ok(n, 'null が返った');
    assert.equal(n.hookSpecificOutput.hookEventName, 'SessionStart');
    for (const t of texts(n)) {
      for (const word of ['WSL', 'orca-ide', 'ORCA_CLI_COMMAND', NOTICE_REF]) {
        assert.ok(t.includes(word), `「${word}」が無い: ${t}`);
      }
    }
  }
});

test('linux：文面に「Linux」「orca-ide」と節への案内がある', () => {
  const n = hook.orcaNotice(input('startup'), LINUX_ENV, never, 'linux');
  assert.ok(n, 'null が返った');
  for (const t of texts(n)) {
    for (const word of ['Linux', 'orca-ide', NOTICE_REF]) assert.ok(t.includes(word), `「${word}」が無い: ${t}`);
  }
});

test('other：文面は今のまま', () => {
  const n = hook.orcaNotice(input('startup'), LINUX_ENV, never, 'darwin');
  assert.ok(n, 'null が返った');
  assert.equal(
    n.systemMessage,
    'Orca の CLI（ORCA_CLI_COMMAND・orca-ide）が見つかりません。今の手順（ship・1セッションの fleet）で進めます。導入は docs/setup.md の節11',
  );
  assert.equal(
    n.hookSpecificOutput.additionalContext,
    'Orca の CLI（ORCA_CLI_COMMAND・orca-ide）が見つかりません。Orca の skill（orca-cli・orchestration）は使わず、今の手順（ship・1セッションの fleet・node harness/scripts/agent.ts worktree）で進めてください。素の orca は実行しないでください。導入は docs/setup.md の節11',
  );
});

test('環境ごとに文面が違う（windows・wsl・linux）', () => {
  const w = hook.orcaNotice(input('startup'), { PATH: 'C:\\a' }, never, 'win32');
  const s = hook.orcaNotice(input('startup'), WSL_ENV, never, 'linux');
  const l = hook.orcaNotice(input('startup'), LINUX_ENV, never, 'linux');
  assert.ok(w && s && l);
  assert.notEqual(w.systemMessage, s.systemMessage);
  assert.notEqual(w.systemMessage, l.systemMessage);
  assert.notEqual(s.systemMessage, l.systemMessage);
});

// ---- どの環境でも ----

const CASES: Array<[string, Env, string]> = [
  ['win32', { PATH: 'C:\\a', PATHEXT: '.EXE' }, 'windows'],
  ['linux', WSL_ENV, 'wsl'],
  ['linux', LINUX_ENV, 'linux'],
  ['darwin', LINUX_ENV, 'other'],
];

test('どの環境でも ORCA_CLI_COMMAND があれば null（isExecutable は呼ばない）', () => {
  for (const [platform, env, label] of CASES) {
    const seen: string[] = [];
    const n = hook.orcaNotice(input('startup'), { ...env, ORCA_CLI_COMMAND: 'orca' }, (p) => {
      seen.push(p);
      return false;
    }, platform);
    assert.equal(n, null, label);
    assert.deepEqual(seen, [], `${label}: ORCA_CLI_COMMAND があるのに探した`);
  }
});

test('どの環境でも Routine（CLAUDE_CODE_REMOTE_SESSION_ID）なら null', () => {
  for (const [platform, env, label] of CASES) {
    assert.equal(hook.orcaNotice(input('startup'), { ...env, CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_x' }, never, platform), null, label);
  }
});

test('どの環境でも source が startup でない・無い・JSON が壊れているなら null', () => {
  for (const [platform, env, label] of CASES) {
    for (const raw of [input('resume'), input('clear'), input('compact'), input(), '{not json']) {
      assert.equal(hook.orcaNotice(raw, env, never, platform), null, `${label}: ${raw}`);
    }
  }
});
