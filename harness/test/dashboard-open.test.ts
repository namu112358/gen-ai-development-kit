// Issue #816：npm run dashboard で手元のダッシュボードを起動し、ブラウザを開く（OS ごとの開くコマンドの選び方・--no-open・開けないときに止まらないこと）
import assert from 'node:assert/strict';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserCommand, openBrowser, wantsOpen, type BrowserCommand } from '../scripts/dashboard/browser.ts';

const root = join(import.meta.dirname, '..', '..');
const URL_WITH_AMP = 'http://127.0.0.1:4317/?a=1&b=2';

test('browserCommand は OS ごとに開くコマンドを選び、URL を最後の引数にそのまま1つで渡す', () => {
  const cases: { name: string; platform: string; env: Record<string, string | undefined>; expected: BrowserCommand }[] = [
    { name: 'win32', platform: 'win32', env: {}, expected: { command: 'rundll32', args: ['url.dll,FileProtocolHandler', URL_WITH_AMP] } },
    { name: 'darwin', platform: 'darwin', env: {}, expected: { command: 'open', args: [URL_WITH_AMP] } },
    { name: 'linux', platform: 'linux', env: {}, expected: { command: 'xdg-open', args: [URL_WITH_AMP] } },
    {
      name: 'linux＋WSL_DISTRO_NAME',
      platform: 'linux',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      expected: { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', URL_WITH_AMP] },
    },
    { name: 'linux で WSL_DISTRO_NAME が空文字', platform: 'linux', env: { WSL_DISTRO_NAME: '' }, expected: { command: 'xdg-open', args: [URL_WITH_AMP] } },
    { name: 'freebsd', platform: 'freebsd', env: {}, expected: { command: 'xdg-open', args: [URL_WITH_AMP] } },
  ];
  for (const c of cases) {
    const got = browserCommand(c.platform, URL_WITH_AMP, c.env);
    assert.deepEqual(got, c.expected, c.name);
    assert.equal(got.args[got.args.length - 1], URL_WITH_AMP, `${c.name}：URL は最後の引数にそのまま入る`);
    assert.equal(got.args.filter((a) => a.includes(URL_WITH_AMP)).length, 1, `${c.name}：& を含む URL が1つの引数のまま`);
  }
});

test('wantsOpen は --no-open が無ければ真、あれば偽', () => {
  const cases: { args: string[]; expected: boolean }[] = [
    { args: [], expected: true },
    { args: ['--no-open'], expected: false },
    { args: ['--port', '5000', '--no-open'], expected: false },
  ];
  for (const c of cases) assert.equal(wantsOpen(c.args), c.expected, JSON.stringify(c.args));
});

type FakeChild = EventEmitter & { unref: () => void; unrefCalls: number };
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };
  return child;
}

type SpawnCall = { command: string; args: string[]; options: SpawnOptions };
function fakeSpawn(child: FakeChild): { calls: SpawnCall[]; spawn: (command: string, args: string[], options: SpawnOptions) => ChildProcess } {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
  };
}

test('openBrowser は browserCommand と同じコマンド・引数で1回だけ切り離して起動し、unref して、onFail を呼ばない', () => {
  const platforms: { platform: string; env: Record<string, string | undefined> }[] = [
    { platform: 'win32', env: {} },
    { platform: 'darwin', env: {} },
    { platform: 'linux', env: {} },
    { platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' } },
  ];
  for (const p of platforms) {
    const label = `${p.platform} ${JSON.stringify(p.env)}`;
    const child = fakeChild();
    const { calls, spawn } = fakeSpawn(child);
    const fails: string[] = [];
    openBrowser(URL_WITH_AMP, { onFail: (m) => fails.push(m), spawn, platform: p.platform, env: p.env });
    const expected = browserCommand(p.platform, URL_WITH_AMP, p.env);
    assert.equal(calls.length, 1, `${label}：spawn は1回だけ`);
    assert.equal(calls[0]!.command, expected.command, label);
    assert.deepEqual(calls[0]!.args, expected.args, label);
    assert.equal(calls[0]!.options.detached, true, `${label}：detached`);
    assert.equal(calls[0]!.options.stdio, 'ignore', `${label}：stdio は ignore`);
    assert.ok(!calls[0]!.options.shell, `${label}：shell を付けない`);
    assert.equal(child.unrefCalls, 1, `${label}：unref を呼ぶ`);
    assert.deepEqual(fails, [], `${label}：onFail を呼ばない`);
  }
});

test('openBrowser は起動した子が error を出しても投げず、onFail に知らせる', () => {
  const child = fakeChild();
  const { calls, spawn } = fakeSpawn(child);
  const fails: string[] = [];
  assert.doesNotThrow(() => openBrowser(URL_WITH_AMP, { onFail: (m) => fails.push(m), spawn, platform: 'linux', env: {} }));
  assert.equal(calls.length, 1);
  assert.doesNotThrow(() => child.emit('error', new Error('spawn xdg-open ENOENT')));
  assert.deepEqual(fails, ['spawn xdg-open ENOENT']);
});

test('openBrowser は spawn が同期で投げても投げず、onFail に知らせる', () => {
  const fails: string[] = [];
  const spawn = (): ChildProcess => {
    throw new Error('EACCES');
  };
  assert.doesNotThrow(() => openBrowser(URL_WITH_AMP, { onFail: (m) => fails.push(m), spawn, platform: 'win32', env: {} }));
  assert.deepEqual(fails, ['EACCES']);
});

test('package.json の scripts.dashboard がダッシュボードを起動し、scripts.check は変わらない', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.match(pkg.scripts?.dashboard ?? '', /harness\/scripts\/dashboard\.ts/);
  assert.equal(pkg.scripts?.check, 'npm run typecheck && npm test');
});
