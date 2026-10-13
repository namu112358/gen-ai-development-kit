// Issue #821：アカウントごとに claude -p を1回呼んで使用量を控えに書くコマンド（harness/scripts/accounts/probe.ts）を確かめる。
// parseProbeOutput が stream-json の rate_limit_event から 5h・7d を読み、無い・壊れた出力は失敗にすること。
// runProbe が古い控え・控えの無いアカウントだけを問い合わせ、控えが新しい・候補から外れるアカウントは問い合わせず、
// 書いた控え（source: probe）を pick.ts の runPick が読めて、Orca と 20 ポイント以上ずれたものだけが mismatches に出ること。
// 一時ディレクトリを home にして対応表・控え・.claude.json を置き、runClaude・runOrca は deps で差し替える（claude・Orca・git は起動しない）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { runPick } from '../scripts/accounts/pick.ts';
import { MISMATCH_POINTS, PROBE_TIMEOUT_MS, parseProbeOutput, runProbe, type ProbeDeps, type ProbeResult } from '../scripts/accounts/probe.ts';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60000;
const REPO = '/work/repo-main';
const EMAIL = 'someone@example.com';
const RESET5 = 1_792_000_000;
const RESET7 = 1_792_500_000;

const tmp = mkdtempSync(join(tmpdir(), 'account-probe-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** stream-json の rate_limit_event の1行 */
const rlLine = (five: number | undefined, seven?: number, status = 'allowed'): string =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      unifiedWindows: {
        five_hour: five === undefined ? { resetsAt: RESET5 } : { utilization: five, resetsAt: RESET5 },
        ...(seven === undefined ? {} : { seven_day: { utilization: seven, resetsAt: RESET7 } }),
      },
    },
  });
const SYSTEM = JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-haiku' });
const ASSISTANT = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '1' }] } });
const RESULT = JSON.stringify({ type: 'result', subtype: 'success', result: '1' });
const stream = (...lines: string[]): string => lines.join('\n') + '\n';

test('parseProbeOutput：stream-json の最後の rate_limit_event から 5h・7d とリセットのミリ秒を読み、無い・壊れた出力は失敗', () => {
  assert.equal(PROBE_TIMEOUT_MS, 90_000);
  const cases: { label: string; text: string; expect: ReturnType<typeof parseProbeOutput> }[] = [
    {
      label: '壊れた行を飛ばし、最後の rate_limit_event を使う',
      text: stream(SYSTEM, '{not json', rlLine(0.9, 0.5, 'rejected'), ASSISTANT, rlLine(0.42, 0.07), RESULT),
      expect: { fiveHour: 42, fiveHourResetsAt: RESET5 * 1000, sevenDay: 7, sevenDayResetsAt: RESET7 * 1000, status: 'allowed' },
    },
    {
      label: 'seven_day が無ければ 7d は null',
      text: stream(SYSTEM, rlLine(0.3), ASSISTANT, RESULT),
      expect: { fiveHour: 30, fiveHourResetsAt: RESET5 * 1000, sevenDay: null, sevenDayResetsAt: null, status: 'allowed' },
    },
    { label: 'rate_limit_event が無い', text: stream(SYSTEM, ASSISTANT, RESULT), expect: null },
    { label: '壊れた行だけ', text: stream('{not json', 'garbage', '{"type":"rate_limit_event"'), expect: null },
    { label: 'five_hour.utilization が無い', text: stream(SYSTEM, rlLine(undefined, 0.1), RESULT), expect: null },
    { label: '空', text: '', expect: null },
  ];
  for (const c of cases) assert.deepEqual(parseProbeOutput(c.text), c.expect, c.label);
});

/** 1つのアカウントの置き方 */
interface AccountSpec {
  name: string;
  /** Orca の 5h（無ければ Orca に使用量が無い） */
  orcaFive?: number;
  /** 控え usage/<org>.json（無ければ置かない） */
  cache?: { five: number; ageMin: number; source?: string };
  /** .claude.json を書き換える */
  claudeJson?: (base: Record<string, unknown>) => Record<string, unknown>;
  /** runClaude が返すもの（configDir ごと） */
  claude?: { stdout: string; error: 'timeout' | 'spawn-failed' | null };
}

const orgOf = (name: string): string => `org-${name}`;
const idOf = (name: string): string => `orca-${name}`;

function setup(accounts: AccountSpec[], opts: { noTable?: boolean } = {}) {
  const home = join(tmp, `home-${++seq}`);
  const base = join(home, '.config', 'agent-harness');
  const configRoot = join(base, 'claude');
  const put = (p: string, text: string): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const usagePath = (name: string): string => join(base, 'usage', `${orgOf(name)}.json`);
  const byDir = new Map<string, AccountSpec>();
  const entries = accounts.map((a) => {
    const configDir = join(configRoot, a.name);
    byDir.set(configDir, a);
    const claude: Record<string, unknown> = {
      hasCompletedOnboarding: true,
      hasSeenAutoModeOutsideReadPrompt: true,
      projects: { [REPO]: { hasTrustDialogAccepted: true } },
      oauthAccount: { organizationUuid: orgOf(a.name), emailAddress: EMAIL, organizationName: 'Secret Org' },
    };
    put(join(configDir, '.claude.json'), JSON.stringify(a.claudeJson ? a.claudeJson(claude) : claude));
    if (a.cache) {
      put(usagePath(a.name), JSON.stringify({
        at: NOW - a.cache.ageMin * MIN,
        session: { usedPercent: a.cache.five, resetsAt: NOW + 90 * MIN },
        weekly: { usedPercent: 1, resetsAt: NOW + 3 * 24 * 60 * MIN },
        ...(a.cache.source ? { source: a.cache.source } : {}),
        configDir,
      }));
    }
    return { orcaId: idOf(a.name), name: a.name, configDir };
  });
  if (!opts.noTable) put(join(base, 'accounts.json'), JSON.stringify({ accounts: entries }));

  const rl = (five: number) => ({
    status: 'allowed',
    session: { usedPercent: five, resetsAt: NOW + 60 * MIN },
    weekly: { usedPercent: 1, resetsAt: NOW + 3 * 24 * 60 * MIN },
    updatedAt: NOW - 1 * MIN,
  });
  const [active, ...inactive] = accounts;
  const orcaJson = JSON.stringify({
    result: {
      claude: { accounts: accounts.map((a) => ({ id: idOf(a.name), organizationUuid: orgOf(a.name), email: EMAIL })), activeAccountId: active ? idOf(active.name) : null },
      rateLimits: {
        claude: active?.orcaFive === undefined ? null : rl(active.orcaFive),
        inactiveClaudeAccounts: inactive.filter((a) => a.orcaFive !== undefined).map((a) => ({ accountId: idOf(a.name), rateLimits: rl(a.orcaFive!) })),
      },
    },
  });

  const claudeCalls: string[] = [];
  const writes: string[] = [];
  const deps: ProbeDeps = {
    home,
    repoRoot: REPO,
    now: NOW,
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    runOrca: () => orcaJson,
    runClaude: (configDir) => {
      claudeCalls.push(configDir);
      return byDir.get(configDir)?.claude ?? { stdout: '', error: 'spawn-failed' };
    },
    writeJson: (p, v) => {
      writes.push(p);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(v));
    },
  };
  return { deps, configRoot, usagePath, claudeCalls, writes };
}

type Done = Extract<ProbeResult, { result: 'done' }>;
const done = (r: ProbeResult): Done => {
  assert.equal(r.result, 'done', JSON.stringify(r));
  return r as Done;
};
const byName = <T extends { name: string }>(xs: T[]): T[] => [...xs].sort((a, b) => a.name.localeCompare(b.name));

test('runProbe：古い控え・控えの無いアカウントだけを問い合わせ、source: probe の控えを書いて runPick が読み、20 ポイント以上のずれだけが mismatches に出る', () => {
  assert.equal(MISMATCH_POINTS, 20);
  const s = setup([
    // 控えが 11 分前 → 問い合わせる。probe 30 と Orca 50 で差 20 → mismatch
    { name: 'stale', orcaFive: 50, cache: { five: 5, ageMin: 11, source: 'probe' }, claude: { stdout: stream(SYSTEM, rlLine(0.3, 0.2), RESULT), error: null } },
    // 控えが無い → 問い合わせる。probe 10 と Orca 29 で差 19 → mismatch にならない
    { name: 'none', orcaFive: 29, claude: { stdout: stream(SYSTEM, rlLine(0.1), RESULT), error: null } },
    // probe でない控えが 5 分前（上限ちょうど）で configDir が対応表と同じ → 問い合わせない
    { name: 'fresh', orcaFive: 90, cache: { five: 90, ageMin: 5 } },
    // 候補から外れる → 問い合わせない
    { name: 'onboard', orcaFive: 0, claudeJson: (b) => ({ ...b, hasCompletedOnboarding: false }) },
  ]);
  const freshBefore = readFileSync(s.usagePath('fresh'), 'utf8');
  const r = done(runProbe(s.deps));

  assert.deepEqual([...s.claudeCalls].sort(), [join(s.configRoot, 'none'), join(s.configRoot, 'stale')]);
  assert.deepEqual(byName(r.probed), [
    { name: 'none', fiveHour: 10, sevenDay: null, status: 'allowed' },
    { name: 'stale', fiveHour: 30, sevenDay: 20, status: 'allowed' },
  ]);
  assert.deepEqual(byName(r.skipped), [{ name: 'fresh', reason: 'fresh' }, { name: 'onboard', reason: 'onboarding' }]);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.mismatches, [{ name: 'stale', probe: 30, orca: 50 }]);

  // 書くのは問い合わせたアカウントの控えだけ
  assert.deepEqual([...s.writes].sort(), [s.usagePath('none'), s.usagePath('stale')].sort());
  assert.equal(readFileSync(s.usagePath('fresh'), 'utf8'), freshBefore);
  assert.deepEqual(JSON.parse(readFileSync(s.usagePath('stale'), 'utf8')), {
    at: NOW,
    session: { usedPercent: 30, resetsAt: RESET5 * 1000 },
    weekly: { usedPercent: 20, resetsAt: RESET7 * 1000 },
    status: 'allowed',
    source: 'probe',
  });
  assert.ok(!JSON.stringify(r).includes(EMAIL));

  // 往復：書いた控えを runPick が probe の値として読む（none の 10 が一番低い）
  const p = runPick({ home: s.deps.home, repoRoot: REPO, now: NOW, readText: s.deps.readText, runOrca: s.deps.runOrca, writeJson: () => {} });
  assert.equal(p.result, 'picked');
  if (p.result === 'picked') {
    assert.equal(p.name, 'none');
    assert.deepEqual([p.usage.source, p.usage.fiveHour], ['probe', 10]);
  }
});

test('runProbe：時間切れ・rate_limit_event の無い出力は failed に出て、控えは書かれない', () => {
  const s = setup([
    { name: 'slow', orcaFive: 10, cache: { five: 5, ageMin: 30 }, claude: { stdout: '', error: 'timeout' } },
    { name: 'nolimit', orcaFive: 10, claude: { stdout: stream(SYSTEM, ASSISTANT, RESULT), error: null } },
  ]);
  const slowBefore = readFileSync(s.usagePath('slow'), 'utf8');
  const r = done(runProbe(s.deps));
  assert.deepEqual(byName(r.failed), [{ name: 'nolimit', reason: 'no-rate-limit-event' }, { name: 'slow', reason: 'timeout' }]);
  assert.deepEqual([r.probed, r.mismatches, s.writes], [[], [], []]);
  assert.equal(readFileSync(s.usagePath('slow'), 'utf8'), slowBefore);
});

test('runProbe：対応表が無い・Orca が読めないときは claude を呼ばずに skipped', () => {
  const none = setup([{ name: 'a', orcaFive: 10 }], { noTable: true });
  assert.deepEqual(runProbe(none.deps), { result: 'skipped', reason: 'no-accounts-table' });
  assert.deepEqual(none.claudeCalls, []);

  const s = setup([{ name: 'a', orcaFive: 10 }]);
  assert.deepEqual(runProbe({ ...s.deps, runOrca: () => null }), { result: 'skipped', reason: 'orca-unreadable' });
  assert.deepEqual([s.claudeCalls, s.writes], [[], []]);
});
