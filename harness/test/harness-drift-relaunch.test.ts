// Issue #807：Orca が無いときのハーネスの交代（harness/scripts/relaunch.ts）。偽の run（tmux・git の呼び出しを記録し、capture-pane の画面を順に返す）・
// 偽の onPath・偽の時計と、一時ディレクトリの git の共通ディレクトリで、relaunchCheck・relaunchStart・relaunchMarkerPath・screenMode を確かめる。
// 起動できるとき：new-window に本体と claude --permission-mode auto が渡り、画面に auto mode が出てから send-keys で1行が渡る。
// 確かめられない（時間切れ・bypass permissions）ときは1行を渡さない。起動できない環境では new-window を呼ばない。同じ交代で2回 start しても起動は1回。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { relaunchCheck, relaunchMarkerPath, relaunchStart, screenMode, type RelaunchDeps } from '../scripts/relaunch.ts';

const SESSION = 'old-session-1';
const PANE = '%42';
const LINE = '/fleet --epic 740 807 808';
const TMUX_VALUE = '/tmp/tmux-1000/default,1234,0';
const AUTO_SCREEN = '╭──────╮\n│ > │\n╰──────╯\n  ⏵⏵ auto mode on (shift+tab to cycle)';
const BYPASS_SCREEN = '╭──────╮\n│ > │\n╰──────╯\n  ⏵⏵ bypass permissions on (shift+tab to cycle)';

interface Call {
  cmd: string;
  args: string[];
  cwd?: string;
}

interface FakeOpts {
  env?: Record<string, string | undefined>;
  onPath?: string[];
  branch?: string;
  porcelain?: string;
  /** capture-pane が順に返す画面（尽きたら最後の画面を返し続ける） */
  screens?: string[];
  newWindowStatus?: number;
  commonDir?: string | null;
}

/** 一時ディレクトリに共通ディレクトリ（<tmp>/.git）を作る。本体は <tmp> */
function tempRepo(t: { after: (fn: () => void) => void }): { main: string; commonDir: string } {
  const main = mkdtempSync(join(tmpdir(), 'relaunch-'));
  t.after(() => rmSync(main, { recursive: true, force: true }));
  const commonDir = join(main, '.git');
  mkdirSync(commonDir, { recursive: true });
  return { main, commonDir };
}

/**
 * 偽の deps。git はサブコマンドで見分ける（status → porcelain の出力、rev-parse・branch・symbolic-ref → 今のブランチ）。
 * tmux は new-window → pane、capture-pane → 画面を順に、send-keys → 成功。sleep は時計を進めるだけで実時間を待たない。
 */
function fakeDeps(commonDir: string | null, opts: FakeOpts = {}): { deps: RelaunchDeps; calls: Call[] } {
  const calls: Call[] = [];
  const screens = opts.screens ?? [AUTO_SCREEN];
  let screenIndex = 0;
  let clock = 1_000_000;
  const branch = opts.branch ?? 'main';
  const available = new Set(opts.onPath ?? ['tmux', 'claude', 'git']);
  const run: RelaunchDeps['run'] = (cmd, args, cwd) => {
    calls.push({ cmd, args: [...args], cwd });
    if (cmd === 'git') {
      if (args.includes('status')) return { status: 0, stdout: opts.porcelain ?? '' };
      if (args.includes('--git-common-dir')) return { status: 0, stdout: `${commonDir ?? ''}\n` };
      if (args.includes('symbolic-ref')) return branch === 'HEAD' ? { status: 1, stdout: '' } : { status: 0, stdout: `${branch}\n` };
      if (args.includes('branch')) return { status: 0, stdout: branch === 'HEAD' ? '\n' : `${branch}\n` };
      if (args.includes('rev-parse')) return { status: 0, stdout: `${branch}\n` };
      return { status: 1, stdout: '' };
    }
    if (cmd === 'tmux') {
      if (args.includes('new-window')) {
        const status = opts.newWindowStatus ?? 0;
        return { status, stdout: status === 0 ? `${PANE}\n` : '' };
      }
      if (args.includes('capture-pane')) {
        const screen = screens[Math.min(screenIndex, screens.length - 1)] ?? '';
        screenIndex += 1;
        return { status: 0, stdout: screen };
      }
      if (args.includes('send-keys')) return { status: 0, stdout: '' };
      return { status: 1, stdout: '' };
    }
    return { status: 1, stdout: '' };
  };
  const deps: RelaunchDeps = {
    env: opts.env ?? { TMUX: TMUX_VALUE, AGENT_HARNESS_SESSION: SESSION },
    run,
    onPath: (command) => available.has(command),
    commonDir: opts.commonDir === undefined ? commonDir : opts.commonDir,
    defaultBranch: 'main',
    sleep: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls };
}

const tmuxCalls = (calls: Call[], sub: string): Call[] => calls.filter((c) => c.cmd === 'tmux' && c.args.includes(sub));

test('relaunchMarkerPath：共通ディレクトリの agent-harness/relaunch/<セッションのキー>.json。セッションが無い・ファイル名に使えない形なら null', () => {
  assert.equal(relaunchMarkerPath('/repo/.git', SESSION), join('/repo/.git', 'agent-harness', 'relaunch', `${SESSION}.json`));
  assert.equal(relaunchMarkerPath('/repo/.git', 'cse_abc'), join('/repo/.git', 'agent-harness', 'relaunch', 'session_abc.json'));
  assert.equal(relaunchMarkerPath('/repo/.git', null), null);
  assert.equal(relaunchMarkerPath('/repo/.git', ''), null);
  assert.equal(relaunchMarkerPath('/repo/.git', 'a/../b'), null);
});

test('screenMode：bypass permissions があれば auto mode の語があっても bypass。auto mode だけなら auto、どちらも無ければ unknown', () => {
  assert.equal(screenMode(`${AUTO_SCREEN}\n${BYPASS_SCREEN}`), 'bypass');
  assert.equal(screenMode(AUTO_SCREEN), 'auto');
  assert.equal(screenMode('Welcome to Claude Code\n? for shortcuts'), 'unknown');
});

test('relaunchCheck：tmux の中・tmux と claude が PATH にある・本体が既定ブランチ・変更なし・セッションあり → ok で本体は共通ディレクトリの親。TMUX の値は出さない', (t) => {
  const { main, commonDir } = tempRepo(t);
  const { deps } = fakeDeps(commonDir);
  const r = relaunchCheck(deps);
  assert.deepEqual(r, { ok: true, means: 'tmux', mainCheckout: main, reason: null });
  assert.ok(!JSON.stringify(r).includes(TMUX_VALUE));
});

test('relaunchCheck・relaunchStart：起動できない環境では ok: false と理由を返し、start は new-window・send-keys を呼ばずに started: false と1行を返す', (t) => {
  const cases: { name: string; opts: FakeOpts; marker?: boolean }[] = [
    { name: 'TMUX が無い', opts: { env: { AGENT_HARNESS_SESSION: SESSION } } },
    { name: 'TMUX が空', opts: { env: { TMUX: '', AGENT_HARNESS_SESSION: SESSION } } },
    { name: 'tmux が PATH に無い', opts: { onPath: ['claude', 'git'] } },
    { name: 'claude が PATH に無い', opts: { onPath: ['tmux', 'git'] } },
    { name: '本体が既定ブランチでない', opts: { branch: 'claude/issue-1-x' } },
    { name: '本体が detached', opts: { branch: 'HEAD' } },
    { name: '本体に未 commit の変更がある', opts: { porcelain: ' M harness/lib/x.ts\n' } },
    { name: '共通ディレクトリが取れない', opts: { commonDir: null } },
    { name: 'セッションが無い', opts: { env: { TMUX: TMUX_VALUE } } },
    { name: 'セッションがファイル名に使えない形', opts: { env: { TMUX: TMUX_VALUE, AGENT_HARNESS_SESSION: 'a/../b' } } },
    { name: 'この交代で既に起動した印がある', opts: {}, marker: true },
  ];
  for (const c of cases) {
    const { commonDir } = tempRepo(t);
    const markerPath = relaunchMarkerPath(commonDir, SESSION);
    assert.ok(markerPath);
    if (c.marker) {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(markerPath, '{}\n');
    }
    const { deps, calls } = fakeDeps(commonDir, c.opts);
    const check = relaunchCheck(deps);
    assert.equal(check.ok, false, `${c.name}：check が ok になりました`);
    assert.equal(typeof check.reason, 'string', `${c.name}：reason がありません`);
    assert.ok((check.reason ?? '').length > 0, `${c.name}：reason が空です`);
    const r = relaunchStart(deps, LINE, 5);
    assert.equal(r.started, false, `${c.name}：start が起動しました`);
    assert.equal(r.verified, false, c.name);
    assert.equal(r.line, LINE, c.name);
    assert.ok((r.reason ?? '').length > 0, `${c.name}：start の reason が空です`);
    assert.equal(tmuxCalls(calls, 'new-window').length, 0, `${c.name}：new-window が呼ばれました`);
    assert.equal(tmuxCalls(calls, 'send-keys').length, 0, `${c.name}：send-keys が呼ばれました`);
    if (!c.marker) assert.equal(existsSync(markerPath), false, `${c.name}：起動した印が書かれました`);
  }
});

test('relaunchStart：本体で claude --permission-mode auto を1行なしで起動し、画面に auto mode が出てから send-keys で1行と Enter を渡して verified: true', (t) => {
  const { main, commonDir } = tempRepo(t);
  const { deps, calls } = fakeDeps(commonDir, { screens: ['', 'Welcome to Claude Code', AUTO_SCREEN] });
  const r = relaunchStart(deps, LINE, 60);
  assert.deepEqual(r, { started: true, verified: true, pane: PANE, reason: null, line: LINE });

  const nw = tmuxCalls(calls, 'new-window');
  assert.equal(nw.length, 1);
  const nwArgs = nw[0]?.args ?? [];
  assert.equal(nwArgs[nwArgs.indexOf('-c') + 1], main, 'new-window の -c が本体ではありません');
  assert.ok(nwArgs.join(' ').includes('claude --permission-mode auto'), `new-window に claude --permission-mode auto がありません: ${nwArgs.join(' ')}`);
  assert.ok(!nwArgs.join(' ').includes(LINE), 'new-window に1行が渡っています（auto mode を確かめる前に段階が進む）');

  const captures = tmuxCalls(calls, 'capture-pane');
  assert.equal(captures.length, 3, 'auto mode が出るまで画面を読み直していません');
  for (const c of captures) assert.equal(c.args[c.args.indexOf('-t') + 1], PANE);

  const keys = tmuxCalls(calls, 'send-keys');
  assert.ok(keys.every((c) => c.args[c.args.indexOf('-t') + 1] === PANE), 'send-keys の宛先が起動した pane ではありません');
  const lineCall = keys.findIndex((c) => c.args.includes('-l') && c.args.includes(LINE));
  const enterCall = keys.findIndex((c) => c.args.includes('Enter'));
  assert.ok(lineCall >= 0, 'send-keys -l で1行が渡っていません');
  assert.ok(enterCall > lineCall, '1行の後に Enter が渡っていません');
  assert.ok(calls.indexOf(captures.at(-1) as Call) < calls.indexOf(keys[0] as Call), 'auto mode を確かめる前に send-keys が呼ばれました');

  const markerPath = relaunchMarkerPath(commonDir, SESSION);
  assert.ok(markerPath && existsSync(markerPath), '起動した印が書かれていません');
});

test('relaunchStart：auto mode を確かめられない（時間切れ・bypass permissions）ときは send-keys を呼ばず、verified: false と pane・理由・1行を返す', (t) => {
  const cases: { name: string; screens: string[] }[] = [
    { name: '時間切れ', screens: ['', 'Welcome to Claude Code'] },
    { name: 'bypass permissions', screens: [BYPASS_SCREEN] },
    { name: 'auto mode と bypass permissions が両方', screens: [`${AUTO_SCREEN}\n${BYPASS_SCREEN}`] },
  ];
  for (const c of cases) {
    const { commonDir } = tempRepo(t);
    const { deps, calls } = fakeDeps(commonDir, { screens: c.screens });
    const r = relaunchStart(deps, LINE, 3);
    assert.equal(r.started, true, c.name);
    assert.equal(r.verified, false, c.name);
    assert.equal(r.pane, PANE, c.name);
    assert.equal(r.line, LINE, c.name);
    assert.ok((r.reason ?? '').length > 0, `${c.name}：reason が空です`);
    assert.equal(tmuxCalls(calls, 'new-window').length, 1, c.name);
    assert.ok(tmuxCalls(calls, 'capture-pane').length >= 1, `${c.name}：画面を読んでいません`);
    assert.equal(tmuxCalls(calls, 'send-keys').length, 0, `${c.name}：send-keys が呼ばれました`);
  }
});

test('relaunchStart：同じ交代で2回 start しても new-window は1回。new-window が失敗しても印は残り、もう一度 start しても起動しない', (t) => {
  {
    const { commonDir } = tempRepo(t);
    const { deps, calls } = fakeDeps(commonDir);
    assert.equal(relaunchStart(deps, LINE, 5).started, true);
    const second = relaunchStart(deps, LINE, 5);
    assert.equal(second.started, false);
    assert.equal(second.line, LINE);
    assert.equal(tmuxCalls(calls, 'new-window').length, 1);
  }
  {
    const { commonDir } = tempRepo(t);
    const { deps, calls } = fakeDeps(commonDir, { newWindowStatus: 1 });
    const first = relaunchStart(deps, LINE, 5);
    assert.equal(first.started, false);
    assert.equal(first.verified, false);
    assert.equal(first.pane, null);
    assert.equal(first.line, LINE);
    assert.ok((first.reason ?? '').length > 0);
    assert.equal(tmuxCalls(calls, 'send-keys').length, 0);
    const markerPath = relaunchMarkerPath(commonDir, SESSION);
    assert.ok(markerPath && existsSync(markerPath), 'new-window が失敗したときに印が残っていません');
    relaunchStart(deps, LINE, 5);
    assert.equal(tmuxCalls(calls, 'new-window').length, 1, '印があるのに new-window がもう一度呼ばれました');
  }
});
