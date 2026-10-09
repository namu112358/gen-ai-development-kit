// Issue #529: Windows の中身の無い python3・python（Microsoft\WindowsApps のスタブ）を呼ぶ Bash を見張りの hook が止め、node か Edit・Write ツールを案内することを確かめる
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  decide,
  isWindowsPythonStub,
  probeOk,
  pythonExists,
  type GuardContext,
  type HookInput,
  type PythonStubDeps,
} from '../../.claude/hooks/guard.ts';

const base: GuardContext = {
  defaultBranch: 'main',
  protectedLabels: ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped'],
  currentBranch: 'claude/529-x',
};
const stub: GuardContext = { ...base, pythonStub: () => true };
const real: GuardContext = { ...base, pythonStub: () => false };

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

const PYTHON_CMDS = [
  'python3 -c "print(1)"',
  'python x.py',
  'cd d && python3 x.py',
  "bash -c 'python3 x.py'",
  'timeout 5 python3 x.py',
  'C:/Users/u/AppData/Local/Microsoft/WindowsApps/python3.exe x.py',
];

test('python3・python がスタブなら止め、理由に node と Edit を書く（包み・前置き・パス付きも）', () => {
  for (const cmd of PYTHON_CMDS) {
    const d = decide(bash(cmd), stub);
    assert.equal(d.deny, true, `止めるべき: ${cmd}`);
    if (d.deny) {
      assert.ok(d.reason.includes('node'), `理由に node が無い: ${cmd}`);
      assert.ok(d.reason.includes('Edit'), `理由に Edit が無い: ${cmd}`);
    }
  }
});

test('python3・python がスタブでない、または見分けが渡されないときは通す', () => {
  for (const c of [real, base]) {
    for (const cmd of PYTHON_CMDS) assert.deepEqual(decide(bash(cmd), c), { deny: false }, `通すべき: ${cmd}`);
  }
});

test('python3-config・pythonx などの別のコマンドは見分けを呼ばずに通す', () => {
  const called: string[] = [];
  const spy: GuardContext = {
    ...base,
    pythonStub: (command) => {
      called.push(command);
      return true;
    },
  };
  for (const cmd of ['python3-config --prefix', 'pythonx a', 'echo python3']) {
    assert.deepEqual(decide(bash(cmd), spy), { deny: false }, `通すべき: ${cmd}`);
  }
  assert.deepEqual(called, []);
});

test('pythonExists：ファイルは true、ディレクトリ・無いパスは false、指す先の無いシンボリックリンクは true', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-python-stub-'));
  try {
    const file = join(dir, 'python3.exe');
    writeFileSync(file, '');
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    assert.equal(pythonExists(file), true, 'ファイル');
    assert.equal(pythonExists(sub), false, 'ディレクトリ');
    assert.equal(pythonExists(join(dir, 'none.exe')), false, '無いパス');
    const link = join(dir, 'dangling.exe');
    try {
      symlinkSync(join(dir, 'missing-target.exe'), link, 'file');
    } catch {
      t.skip('シンボリックリンクを作れない環境');
      return;
    }
    assert.equal(pythonExists(link), true, '指す先の無いシンボリックリンク（スタブと同じ形）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeOk：stdout に印があれば true、0 で何も出ない・9009 で stderr だけは false', () => {
  const cases = [
    { r: { status: 0, stdout: 'agent-harness-python-ok\r\n', stderr: '' }, want: true, label: '印あり' },
    { r: { status: 0, stdout: '', stderr: '' }, want: false, label: '0 で空の stdout（Issue の事例）' },
    {
      r: { status: 9009, stdout: '', stderr: 'Python was not found; run without arguments to install from the Microsoft Store' },
      want: false,
      label: '9009 で stderr だけ',
    },
    { r: { status: null, stdout: undefined, error: new Error('ETIMEDOUT') }, want: false, label: '時間切れ' },
  ];
  for (const c of cases) assert.equal(probeOk(c.r), c.want, c.label);
});

const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
const STUB_PATH = 'c:/users/u/appdata/local/microsoft/windowsapps/python3.exe';

function fakeDeps(over: Partial<PythonStubDeps> & { found?: string[]; probeResult?: boolean }): {
  deps: PythonStubDeps;
  existsCalls: string[];
  probeCalls: string[];
} {
  const existsCalls: string[] = [];
  const probeCalls: string[] = [];
  const found = (over.found ?? []).map(norm);
  const deps: PythonStubDeps = {
    platform: over.platform ?? 'win32',
    path: over.path ?? 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Windows\\System32',
    exists:
      over.exists ??
      ((f) => {
        existsCalls.push(f);
        return found.includes(norm(f));
      }),
    probe:
      over.probe ??
      ((f) => {
        probeCalls.push(f);
        return over.probeResult ?? false;
      }),
  };
  return { deps, existsCalls, probeCalls };
}

test('isWindowsPythonStub：WindowsApps の実体で probe が印を返さなければ true', () => {
  const { deps, probeCalls } = fakeDeps({ found: [STUB_PATH], probeResult: false });
  assert.equal(isWindowsPythonStub('python3', deps), true);
  assert.equal(probeCalls.length, 1);
  assert.equal(norm(probeCalls[0]!), STUB_PATH);
});

test('isWindowsPythonStub：WindowsApps の実体でも probe が印を返せば（Store の本物）false', () => {
  const { deps } = fakeDeps({ found: [STUB_PATH], probeResult: true });
  assert.equal(isWindowsPythonStub('python3', deps), false);
});

test('isWindowsPythonStub：実体が WindowsApps の外なら false で probe を呼ばない', () => {
  const { deps, probeCalls } = fakeDeps({
    path: 'C:\\Python312;C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps',
    found: ['C:\\Python312\\python.exe', 'c:/users/u/appdata/local/microsoft/windowsapps/python.exe'],
    probeResult: false,
  });
  assert.equal(isWindowsPythonStub('python', deps), false);
  assert.deepEqual(probeCalls, []);
});

test('isWindowsPythonStub：PATH に見つからなければ false', () => {
  const { deps, probeCalls } = fakeDeps({ found: [], probeResult: false });
  assert.equal(isWindowsPythonStub('python3', deps), false);
  assert.deepEqual(probeCalls, []);
});

test('isWindowsPythonStub：Windows 以外では exists・probe を呼ばずに false', () => {
  const { deps, existsCalls, probeCalls } = fakeDeps({ platform: 'linux', found: [STUB_PATH], probeResult: false });
  assert.equal(isWindowsPythonStub('python3', deps), false);
  assert.deepEqual(existsCalls, []);
  assert.deepEqual(probeCalls, []);
});

test('isWindowsPythonStub：Git Bash の形のパス（/c/...）は C:/... に直して exists に渡す', () => {
  const { deps, existsCalls } = fakeDeps({ found: [STUB_PATH], probeResult: false });
  assert.equal(isWindowsPythonStub('/c/Users/u/AppData/Local/Microsoft/WindowsApps/python3.exe', deps), true);
  assert.ok(existsCalls.length > 0, 'exists が呼ばれる');
  assert.equal(norm(existsCalls[0]!), STUB_PATH);
});
