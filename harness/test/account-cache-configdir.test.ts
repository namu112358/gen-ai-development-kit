// Issue #976：使用量の控えを、控えの configDir の実パスが対応表のそのアカウントの configDir の実パスと同じときだけ使うこと
// （source: probe の控えは除く）、pick.ts が Orca の使用量を選ぶのに使わないこと、対応表の configDir の `~/` をホームに展開することを確かめる。
// 一時ディレクトリを home にして対応表・控え・.claude.json を置き、Orca・claude は deps で差し替える（起動しない）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { checkConfigDir, expandHome, runPick, type PickResult } from '../scripts/accounts/pick.ts';
import { runProbe, type ProbeResult } from '../scripts/accounts/probe.ts';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60000;
const REPO = '/work/repo-main';
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'account-cache-configdir-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** 控えの configDir を決める（dir は対応表のアカウントの実際のディレクトリ。null なら書かない） */
type CacheDir = (dir: string, home: string) => string | null;
interface Spec { tableDir?: string; cache?: { source: string; dir: CacheDir }; orcaFive?: number }

/** アカウント a を1つ置いた home と、runPick・runProbe の deps を返す */
function setup(spec: Spec) {
  const home = join(tmp, `home-${++seq}`);
  const base = join(home, '.config', 'agent-harness');
  const dir = join(base, 'claude', 'a');
  const put = (p: string, text: string): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  put(join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, hasSeenAutoModeOutsideReadPrompt: true, projects: { [REPO]: { hasTrustDialogAccepted: true } }, oauthAccount: { organizationUuid: 'org-a' } }));
  put(join(base, 'accounts.json'), JSON.stringify({ accounts: [{ orcaId: 'orca-a', name: 'a', configDir: spec.tableDir ?? dir }] }));
  if (spec.cache) {
    const cacheDir = spec.cache.dir(dir, home);
    put(join(base, 'usage', 'org-a.json'), JSON.stringify({
      at: NOW - 1 * MIN,
      session: { usedPercent: 30, resetsAt: NOW + 90 * MIN },
      weekly: { usedPercent: 1, resetsAt: NOW + 3 * 24 * 60 * MIN },
      source: spec.cache.source,
      ...(cacheDir === null ? {} : { configDir: cacheDir }),
    }));
  }
  const rl = (five: number) => ({ status: 'allowed', session: { usedPercent: five, resetsAt: NOW + 60 * MIN }, weekly: { usedPercent: 1, resetsAt: NOW + 3 * 24 * 60 * MIN }, updatedAt: NOW - 1 * MIN });
  const orcaJson = JSON.stringify({
    result: {
      claude: { accounts: [{ id: 'orca-a', organizationUuid: 'org-a' }], activeAccountId: 'orca-a' },
      rateLimits: { claude: spec.orcaFive === undefined ? null : rl(spec.orcaFive), inactiveClaudeAccounts: [] },
    },
  });
  const claudeCalls: string[] = [];
  const deps = {
    home,
    repoRoot: REPO,
    now: NOW,
    readText: (p: string): string | null => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    runOrca: (): string | null => orcaJson,
    runClaude: (configDir: string) => {
      claudeCalls.push(configDir);
      return { stdout: `${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1_792_000_000 } } } })}\n`, error: null };
    },
    writeJson: (): void => {},
  };
  return { home, dir, deps, claudeCalls };
}

const NO_USAGE = { result: 'default', excluded: [{ name: 'a', reason: 'no-usage' }] };
const CASES: { label: string; source?: string; dir: CacheDir; use: boolean }[] = [
  { label: 'configDir が無い', dir: () => null, use: false },
  { label: '対応表と違う', dir: (_d, home) => { const other = join(home, '.config', 'agent-harness', 'claude', 'other'); mkdirSync(other, { recursive: true }); return other; }, use: false },
  { label: '無いディレクトリ', dir: (d) => `${d}-gone`, use: false },
  { label: '対応表と同じ', dir: (d) => d, use: true },
  { label: '~/ で書いた同じ場所', dir: () => '~/.config/agent-harness/claude/a', use: true },
  { label: 'シンボリックリンク経由で同じ実パス', dir: (d, home) => { symlinkSync(d, join(home, 'link')); return join(home, 'link'); }, use: true },
  { label: 'source: probe は configDir が無くても使う', source: 'probe', dir: () => null, use: true },
];

test('runPick：source が probe でない控えは configDir の実パスが対応表と同じときだけ使い、無い・違う控えは使わない', () => {
  for (const c of CASES) {
    const s = setup({ cache: { source: c.source ?? 'statusline', dir: c.dir } });
    const r = runPick(s.deps);
    if (c.use) assert.deepEqual([r.result, r.result === 'picked' ? r.usage.fiveHour : null], ['picked', 30], c.label);
    else assert.deepEqual({ result: r.result, excluded: r.excluded }, NO_USAGE, c.label);
  }
});

test('runProbe：configDir が無い・違う控えは fresh にならずに問い合わせ、合う控えと source: probe の控えは fresh で問い合わせない', () => {
  for (const c of CASES) {
    const s = setup({ cache: { source: c.source ?? 'statusline', dir: c.dir } });
    const r = runProbe(s.deps) as Extract<ProbeResult, { result: 'done' }>;
    assert.equal(r.result, 'done', c.label);
    if (c.use) assert.deepEqual([r.skipped, s.claudeCalls], [[{ name: 'a', reason: 'fresh' }], []], c.label);
    else assert.deepEqual([r.skipped, s.claudeCalls, r.probed.length], [[], [s.dir], 1], c.label);
  }
});

test('expandHome と checkConfigDir：`~` と `~/` だけをホームに展開し、`~user/x`・相対パスは展開せず outside-config-root', () => {
  const home = '/home/u';
  const claude = JSON.stringify({ hasCompletedOnboarding: true, hasSeenAutoModeOutsideReadPrompt: true, projects: { [REPO]: { hasTrustDialogAccepted: true } }, oauthAccount: { organizationUuid: 'org-a' } });
  const cases: { dir: string; expanded: string; reason: string | null }[] = [
    { dir: '~', expanded: home, reason: 'outside-config-root' },
    { dir: '~/.config/agent-harness/claude/a', expanded: '/home/u/.config/agent-harness/claude/a', reason: null },
    { dir: '~user/x', expanded: '~user/x', reason: 'outside-config-root' },
    { dir: '.config/agent-harness/claude/a', expanded: '.config/agent-harness/claude/a', reason: 'outside-config-root' },
  ];
  for (const c of cases) {
    assert.equal(expandHome(c.dir, home), c.expanded, c.dir);
    const reason = checkConfigDir({ orcaId: 'orca-a', name: 'a', configDir: c.dir }, { home, repoRoot: REPO, orgUuid: 'org-a', readText: () => claude });
    assert.equal(reason, c.reason, c.dir);
  }
});

test('対応表の configDir が ~/… でも、runPick の前置きと runProbe が claude に渡すパスは絶対パス', () => {
  const tableDir = '~/.config/agent-harness/claude/a';
  const p = setup({ tableDir, cache: { source: 'statusline', dir: (d) => d } });
  const r: PickResult = runPick(p.deps);
  assert.deepEqual([r.result, r.prefix], ['picked', `CLAUDE_CONFIG_DIR='${p.dir}' `]);

  const q = setup({ tableDir });
  assert.equal(runProbe(q.deps).result, 'done');
  assert.deepEqual(q.claudeCalls, [q.dir]);
});

test('runPick：Orca の使用量だけがあり控えが無いアカウントは no-usage で外れる', () => {
  const r = runPick(setup({ orcaFive: 10 }).deps);
  assert.deepEqual({ result: r.result, excluded: r.excluded }, NO_USAGE);
});
