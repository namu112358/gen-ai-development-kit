// Issue #826：panes.ts idle（hq の見回しで長く出力の無い claude のタブを出す）の判定・行の書式・Orca の読み取り・引数を確かめる。
// 8時間出力の無い claude のタブが1行で出ること、しきい値未満・claude でない・除外の handle のタブが出ないことが AC。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HQ_STALL_DEFAULTS } from '../lib/hq-stall.ts';
import { idleTabs, parseIdleArgs, readIdleTabs, renderIdleTab, type RunResult } from '../scripts/panes.ts';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60_000;
const DEFAULT_MINUTES = HQ_STALL_DEFAULTS.stuckMinutes;

interface Tab { handle: string; title?: string; worktreePath?: string; agentIdentity?: string; lastOutputAt?: unknown }
const tab = (handle: string, ago: number | null, extra: Partial<Tab> = {}): Tab => ({
  handle,
  title: `t-${handle}`,
  worktreePath: `/w/${handle}`,
  agentIdentity: 'claude',
  ...(ago === null ? {} : { lastOutputAt: NOW - ago * MIN }),
  ...extra,
});
const list = (...terminals: Tab[]): unknown => ({ ok: true, result: { terminals } });
const handles = (r: ReturnType<typeof idleTabs>): string[] => {
  assert.equal(r.ok, true);
  return r.ok ? r.tabs.map((t) => t.handle) : [];
};

// 1つのタブずつ、出るか出ないか（境界は「以上」。--minutes の上書き・ISO の文字列はここに1件ずつ）
const cases: { name: string; tab: Tab; minutes?: number; exclude?: string[]; shown: boolean }[] = [
  { name: '8時間出力の無い claude のタブは出る', tab: tab('a', 480), shown: true },
  { name: 'しきい値ちょうど（既定）は出る', tab: tab('a', DEFAULT_MINUTES), shown: true },
  { name: 'しきい値未満は出ない', tab: tab('a', DEFAULT_MINUTES - 1), shown: false },
  { name: 'agentIdentity が codex は出ない', tab: tab('a', 480, { agentIdentity: 'codex' }), shown: false },
  { name: 'agentIdentity が無いと出ない', tab: tab('a', 480, { agentIdentity: undefined }), shown: false },
  { name: '--exclude の handle は出ない', tab: tab('a', 480), exclude: ['x', 'a'], shown: false },
  { name: 'lastOutputAt が日時でない文字列なら出ない', tab: tab('a', null, { lastOutputAt: 'yesterday-ish' }), shown: false },
  { name: 'lastOutputAt が無いと出ない', tab: tab('a', null), shown: false },
  { name: 'ISO の文字列の lastOutputAt でも8時間前なら出る', tab: tab('a', null, { lastOutputAt: new Date(NOW - 480 * MIN).toISOString() }), shown: true },
  { name: '--minutes の上書きで8時間はしきい値未満になる', tab: tab('a', 480), minutes: 481, shown: false },
];
for (const c of cases) {
  test(`idleTabs：${c.name}`, () => {
    const r = idleTabs(list(c.tab), NOW, c.minutes ?? DEFAULT_MINUTES, c.exclude ?? []);
    assert.deepEqual(handles(r), c.shown ? ['a'] : []);
  });
}

test('idleTabs：経過の分と title・worktreePath を返し、無いものは空文字にする', () => {
  const r = idleTabs(list(tab('a', 480), tab('b', 500, { title: undefined, worktreePath: undefined })), NOW, DEFAULT_MINUTES, []);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.tabs, [
    { handle: 'a', minutes: 480, title: 't-a', worktreePath: '/w/a' },
    { handle: 'b', minutes: 500, title: '', worktreePath: '' },
  ]);
});

test('renderIdleTab：長く出力の無いタブ：<handle>・<分>分・<title>（<worktreePath>）の1行', () => {
  assert.equal(
    renderIdleTab({ handle: 'term_1', minutes: 480, title: 'ship #12', worktreePath: '/w/x' }),
    '長く出力の無いタブ：term_1・480分・ship #12（/w/x）',
  );
});

test('readIdleTabs：Orca に terminal list --json だけを渡し、8時間止まった claude のタブを1行で返す', () => {
  const calls: { cmd: string; args: string[] }[] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push({ cmd, args });
    const body = list(tab('a', 480), tab('b', 10), tab('c', 480, { agentIdentity: 'codex' }), tab('hq', 480));
    return { status: 0, stdout: JSON.stringify(body), stderr: '' };
  };
  const lines = readIdleTabs(run, 'orca', NOW, DEFAULT_MINUTES, ['hq']);
  assert.deepEqual(calls, [{ cmd: 'orca', args: ['terminal', 'list', '--json'] }]);
  assert.deepEqual(lines, ['長く出力の無いタブ：a・480分・t-a（/w/a）']);
});

const failures: { name: string; result: RunResult }[] = [
  { name: '終了コードが 0 でない', result: { status: 1, stdout: '', stderr: 'boom\nconnection refused' } },
  { name: 'JSON でない', result: { status: 0, stdout: 'not json', stderr: '' } },
  { name: 'result.terminals が無い', result: { status: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: '' } },
];
for (const f of failures) {
  test(`readIdleTabs：${f.name}ときは「Orca のタブの一覧を読めません」の1行だけを返す`, () => {
    const lines = readIdleTabs(() => f.result, 'orca', NOW, DEFAULT_MINUTES, []);
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /^Orca のタブの一覧を読めません（.+）$/);
  });
}

test('parseIdleArgs：--exclude を繰り返しで集め、--minutes は正の整数だけを受ける', () => {
  assert.deepEqual(parseIdleArgs([]), { excludes: [], minutes: null });
  assert.deepEqual(parseIdleArgs(['--exclude', 'a', '--minutes', '30', '--exclude', 'b']), { excludes: ['a', 'b'], minutes: 30 });
  for (const bad of ['0', '-5', '1.5', 'abc']) {
    assert.throws(() => parseIdleArgs(['--minutes', bad]), Error, `--minutes ${bad}`);
  }
});
