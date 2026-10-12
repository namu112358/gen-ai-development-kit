// Issue #820：使用量の低い Claude のアカウントを選ぶコマンド（harness/scripts/accounts/pick.ts）を確かめる。
// 一時ディレクトリを home にして対応表・控え・.claude.json を置き、Orca の出力は runPick の deps で差し替える（Orca・git は起動しない）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { runPick, shellPrefix } from '../scripts/accounts/pick.ts';

const root = realpathSync(join(import.meta.dirname, '..', '..'));
const PICK = join(root, 'harness', 'scripts', 'accounts', 'pick.ts');
const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const MIN = 60000;
const REPO = '/work/repo-main';
const EMAIL = 'someone@example.com';

const tmp = mkdtempSync(join(tmpdir(), 'account-pick-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
let seq = 0;

/** 1つのアカウントの置き方 */
interface AccountSpec {
  name: string;
  /** Orca の値（無ければ Orca に使用量が無い） */
  orca?: { five: number | null; reset?: number | null; seven?: number | null; status?: string; ageMin?: number };
  /** 控え usage/<org>.json（無ければ置かない） */
  cache?: { five: number | null; reset?: number | null; seven?: number | null; status?: string; source?: string; ageMin: number };
  /** configDir を差し替える（root は ~/.config/agent-harness/claude） */
  configDir?: (configRoot: string, home: string) => string;
  /** .claude.json の中身（null なら置かない、文字列ならそのまま書く） */
  claudeJson?: null | string | ((base: Record<string, unknown>) => Record<string, unknown>);
  /** Orca の organizationUuid と違う組織を .claude.json に書く */
  orgInClaudeJson?: string;
}

interface Setup {
  accounts: AccountSpec[];
  threshold5h?: number;
  launches?: { name: string; at: number }[];
  /** 対応表を置かない */
  noTable?: boolean;
}

interface PickOut {
  result: 'picked' | 'wait' | 'default';
  prefix: string;
  name?: string;
  orcaId?: string;
  usage?: { fiveHour: number | null; source: string };
  excluded?: { name: string; reason: string }[];
  resetAt?: string | null;
  reason?: string;
}

const orgOf = (name: string): string => `org-${name}`;
const idOf = (name: string): string => `orca-${name}`;
const rl = (v: NonNullable<AccountSpec['orca']>, i: number) => ({
  status: v.status ?? 'allowed',
  session: { usedPercent: v.five, resetsAt: v.reset === undefined ? NOW + (60 + i * 10) * MIN : v.reset },
  weekly: { usedPercent: v.seven ?? null, resetsAt: NOW + 3 * 24 * 60 * MIN },
  updatedAt: NOW - (v.ageMin ?? 1) * MIN,
});

/** 一時ディレクトリに home を作り、runPick の deps と Orca の JSON を返す */
function setup(s: Setup) {
  const home = join(tmp, `home-${++seq}`);
  const base = join(home, '.config', 'agent-harness');
  const configRoot = join(base, 'claude');
  const put = (p: string, text: string): void => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const entries = s.accounts.map((a) => {
    const configDir = a.configDir ? a.configDir(configRoot, home) : join(configRoot, a.name);
    mkdirSync(configDir, { recursive: true });
    const claude: Record<string, unknown> = {
      hasCompletedOnboarding: true,
      hasSeenAutoModeOutsideReadPrompt: true,
      projects: { [REPO]: { hasTrustDialogAccepted: true } },
      oauthAccount: { organizationUuid: a.orgInClaudeJson ?? orgOf(a.name), emailAddress: EMAIL, organizationName: 'Secret Org' },
    };
    if (a.claudeJson === undefined) put(join(configDir, '.claude.json'), JSON.stringify(claude));
    else if (typeof a.claudeJson === 'string') put(join(configDir, '.claude.json'), a.claudeJson);
    else if (a.claudeJson !== null) put(join(configDir, '.claude.json'), JSON.stringify(a.claudeJson(claude)));
    if (a.cache) {
      const c = a.cache;
      put(join(base, 'usage', `${orgOf(a.name)}.json`), JSON.stringify({
        at: NOW - c.ageMin * MIN,
        session: { usedPercent: c.five, resetsAt: c.reset === undefined ? NOW + 90 * MIN : c.reset },
        weekly: { usedPercent: c.seven ?? null, resetsAt: NOW + 3 * 24 * 60 * MIN },
        ...(c.source ? { source: c.source } : {}),
        ...(c.status ? { status: c.status } : {}),
      }));
    }
    return { orcaId: idOf(a.name), name: a.name, configDir };
  });
  if (!s.noTable) put(join(base, 'accounts.json'), JSON.stringify({ ...(s.threshold5h === undefined ? {} : { threshold5h: s.threshold5h }), accounts: entries }));
  if (s.launches) put(join(base, 'usage', 'launches.json'), JSON.stringify(s.launches));

  const [active, ...inactive] = s.accounts;
  const orcaJson = JSON.stringify({
    result: {
      claude: {
        accounts: s.accounts.map((a) => ({ id: idOf(a.name), organizationUuid: orgOf(a.name), email: EMAIL })),
        activeAccountId: active ? idOf(active.name) : null,
      },
      rateLimits: {
        claude: active?.orca ? rl(active.orca, 0) : null,
        inactiveClaudeAccounts: inactive.filter((a) => a.orca).map((a) => ({ accountId: idOf(a.name), rateLimits: rl(a.orca!, s.accounts.indexOf(a)) })),
      },
    },
  });

  const writes: string[] = [];
  let orcaCalls = 0;
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
    runOrca: (): string | null => {
      orcaCalls++;
      return orcaJson;
    },
    writeJson: (p: string, value: unknown): void => {
      writes.push(p);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(value));
    },
  };
  const launchesPath = join(base, 'usage', 'launches.json');
  return { home, configRoot, deps, writes, launchesPath, entries, orcaCalls: () => orcaCalls };
}

const pick = async (deps: Parameters<typeof runPick>[0]): Promise<PickOut> => (await runPick(deps)) as PickOut;
const byName = (xs: { name: string; reason: string }[] = []) => [...xs].sort((a, b) => a.name.localeCompare(b.name));

test('低いアカウントが選ばれ、前置きは単一引用符の CLAUDE_CONFIG_DIR で、launches.json だけに1件足される', async () => {
  const s = setup({ accounts: [{ name: 'a', orca: { five: 60, seven: 10 } }, { name: 'b', orca: { five: 20, seven: 10 } }], launches: [{ name: 'a', at: NOW - 5 * MIN }] });
  const r = await pick(s.deps);
  assert.equal(r.result, 'picked');
  assert.equal(r.name, 'b');
  assert.equal(r.orcaId, idOf('b'));
  assert.equal(r.prefix, `CLAUDE_CONFIG_DIR='${s.entries[1]!.configDir}' `);
  assert.deepEqual(s.writes, [s.launchesPath]);
  assert.deepEqual(JSON.parse(readFileSync(s.launchesPath, 'utf8')), [{ name: 'a', at: NOW - 5 * MIN }, { name: 'b', at: NOW }]);
  // 中の単一引用符は '\'' にする
  assert.equal(shellPrefix("/x/it's"), "CLAUDE_CONFIG_DIR='/x/it'\\''s' ");
});

test('選び方の順：しきい値・rejected・起こした数の +10・5h が同じなら 7d（null は 0）・それも同じなら対応表の順', async () => {
  const cases: { label: string; a: AccountSpec['orca']; b: AccountSpec['orca']; launches?: { name: string; at: number }[]; threshold5h?: number; expect: string }[] = [
    { label: '5h が低いほう', a: { five: 40 }, b: { five: 30 }, expect: 'b' },
    { label: '値の後に起こした1件で +10', a: { five: 30, ageMin: 2 }, b: { five: 25, ageMin: 2 }, launches: [{ name: 'b', at: NOW - 1 * MIN }], expect: 'a' },
    { label: '値より前に起こした分は数えない', a: { five: 30, ageMin: 2 }, b: { five: 25, ageMin: 2 }, launches: [{ name: 'b', at: NOW - 3 * MIN }], expect: 'b' },
    { label: '5h が同じなら 7d が低いほう', a: { five: 30, seven: 50 }, b: { five: 30, seven: 20 }, expect: 'b' },
    { label: '7d の null は 0', a: { five: 30, seven: 10 }, b: { five: 30, seven: null }, expect: 'b' },
    { label: '全部同じなら対応表の順', a: { five: 30, seven: 20 }, b: { five: 30, seven: 20, reset: NOW + 200 * MIN }, expect: 'a' },
    { label: 'しきい値ちょうどは外れる（既定 80）', a: { five: 80 }, b: { five: 79 }, expect: 'b' },
    { label: 'threshold5h を読む', a: { five: 10 }, b: { five: 50 }, threshold5h: 40, expect: 'a' },
    { label: 'rejected は外れる', a: { five: 10, status: 'rejected' }, b: { five: 50 }, expect: 'b' },
  ];
  for (const c of cases) {
    const s = setup({ accounts: [{ name: 'a', orca: c.a }, { name: 'b', orca: c.b }], launches: c.launches, threshold5h: c.threshold5h });
    const r = await pick(s.deps);
    assert.equal(r.result, 'picked', c.label);
    assert.equal(r.name, c.expect, c.label);
  }
});

test('取り元の順：10 分以内の probe の控え > 5 分以内のほかの控え > 30 分以内の Orca、古いものは使わない', async () => {
  const cases: { label: string; cache?: AccountSpec['cache']; orca?: AccountSpec['orca']; expect: { source: string; five: number } | 'no-usage' }[] = [
    { label: '新しい probe', cache: { five: 11, source: 'probe', ageMin: 9 }, orca: { five: 50 }, expect: { source: 'probe', five: 11 } },
    { label: '古い probe は Orca に落ちる', cache: { five: 11, source: 'probe', ageMin: 11 }, orca: { five: 50 }, expect: { source: 'orca', five: 50 } },
    { label: '新しいほかの控え', cache: { five: 22, ageMin: 4 }, orca: { five: 50 }, expect: { source: 'cache', five: 22 } },
    { label: '古いほかの控えは Orca に落ちる', cache: { five: 22, ageMin: 6 }, orca: { five: 50 }, expect: { source: 'orca', five: 50 } },
    { label: '5h が null の控えは使えない', cache: { five: null, source: 'probe', ageMin: 1 }, orca: { five: 50 }, expect: { source: 'orca', five: 50 } },
    { label: '30 分以内の Orca', orca: { five: 50, ageMin: 29 }, expect: { source: 'orca', five: 50 } },
    { label: '古い Orca だけなら使える値が無い', cache: { five: 22, ageMin: 6 }, orca: { five: 50, ageMin: 31 }, expect: 'no-usage' },
  ];
  for (const c of cases) {
    const s = setup({ accounts: [{ name: 'a', cache: c.cache, orca: c.orca }] });
    const r = await pick(s.deps);
    if (c.expect === 'no-usage') {
      assert.equal(r.result, 'default', c.label);
      assert.equal(r.prefix, '', c.label);
      assert.deepEqual(r.excluded, [{ name: 'a', reason: 'no-usage' }], c.label);
    } else {
      assert.equal(r.result, 'picked', c.label);
      assert.deepEqual([r.usage?.source, r.usage?.fiveHour], [c.expect.source, c.expect.five], c.label);
    }
  }
});

test('取り違え：問い合わせでない値が 5h 同じ・リセットの差 120 秒以内・7d 同じなら両方使わず、probe の控えがあるほうが probe の値で選ばれる', async () => {
  const cases: { label: string; resetGapSec: number; expect: { name: string; source: string; excludedA: boolean } }[] = [
    { label: '差 120 秒は取り違え', resetGapSec: 120, expect: { name: 'b', source: 'probe', excludedA: true } },
    { label: '差 121 秒は取り違えでない', resetGapSec: 121, expect: { name: 'a', source: 'orca', excludedA: false } },
  ];
  for (const c of cases) {
    const reset = NOW + 100 * MIN;
    const s = setup({
      accounts: [
        { name: 'a', orca: { five: 40, seven: 30, reset } },
        { name: 'b', orca: { five: 40, seven: 30, reset: reset + c.resetGapSec * 1000 }, cache: { five: 70, seven: 5, source: 'probe', ageMin: 2 } },
      ],
    });
    const r = await pick(s.deps);
    assert.equal(r.result, 'picked', c.label);
    assert.deepEqual([r.name, r.usage?.source], [c.expect.name, c.expect.source], c.label);
    assert.equal((r.excluded ?? []).some((e) => e.name === 'a' && e.reason === 'no-usage'), c.expect.excludedA, c.label);
  }
});

test('全部の 5h がしきい値以上（rejected を含む）なら wait と一番早い 5h のリセットの時刻', async () => {
  const early = NOW + 30 * MIN;
  const s = setup({
    accounts: [
      { name: 'a', orca: { five: 85, reset: NOW + 90 * MIN } },
      { name: 'b', orca: { five: 20, status: 'rejected', reset: early } },
      { name: 'c', orca: { five: 95, reset: null } },
    ],
  });
  const r = await pick(s.deps);
  assert.equal(r.result, 'wait');
  assert.equal(r.prefix, '');
  assert.equal(r.resetAt, new Date(early).toISOString());
  assert.deepEqual(s.writes, []);
});

test('設定ディレクトリが外・.claude.json が読めない・フラグが偽・組織が違うと理由つきで外れ、メールアドレスを出さない', async () => {
  const s = setup({
    accounts: [
      { name: 'outside', orca: { five: 1 }, configDir: (_r, home) => join(home, 'elsewhere', 'outside') },
      { name: 'sibling', orca: { five: 1 }, configDir: (r) => `${r}-evil` },
      { name: 'dotdot', orca: { five: 1 }, configDir: (r) => `${r}/../dotdot` },
      { name: 'missing', orca: { five: 1 }, claudeJson: null },
      { name: 'broken', orca: { five: 1 }, claudeJson: '{not json' },
      { name: 'onboard', orca: { five: 1 }, claudeJson: (b) => ({ ...b, hasCompletedOnboarding: false }) },
      { name: 'trust', orca: { five: 1 }, claudeJson: (b) => ({ ...b, projects: { '/other/repo': { hasTrustDialogAccepted: true } } }) },
      { name: 'automode', orca: { five: 1 }, claudeJson: (b) => { const { hasSeenAutoModeOutsideReadPrompt: _, ...rest } = b; return rest; } },
      { name: 'org', orca: { five: 1 }, orgInClaudeJson: 'org-someone-else' },
      { name: 'good', orca: { five: 60 } },
    ],
  });
  const before = readFileSync(join(s.configRoot, 'good', '.claude.json'), 'utf8');
  const r = await pick(s.deps);
  assert.equal(r.result, 'picked');
  assert.equal(r.name, 'good');
  assert.deepEqual(byName(r.excluded), byName([
    { name: 'outside', reason: 'outside-config-root' },
    { name: 'sibling', reason: 'outside-config-root' },
    { name: 'dotdot', reason: 'outside-config-root' },
    { name: 'missing', reason: 'unreadable-claude-json' },
    { name: 'broken', reason: 'unreadable-claude-json' },
    { name: 'onboard', reason: 'onboarding' },
    { name: 'trust', reason: 'trust' },
    { name: 'automode', reason: 'auto-mode-prompt' },
    { name: 'org', reason: 'org-mismatch' },
  ]));
  assert.equal(readFileSync(join(s.configRoot, 'good', '.claude.json'), 'utf8'), before);
  assert.ok(!JSON.stringify(r).includes(EMAIL));
});

test('対応表が無いとき CLI は default と空の前置きを終了コード 0 で返し、Orca が読めないときも default', async () => {
  const home = mkdtempSync(join(tmp, 'cli-home-'));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  const c = spawnSync(process.execPath, [PICK], { cwd: home, encoding: 'utf8', env });
  assert.equal(c.status, 0, c.stderr);
  const out = JSON.parse(c.stdout) as PickOut;
  assert.deepEqual([out.result, out.prefix], ['default', '']);

  // 対応表が無ければ Orca を呼ばない
  const none = setup({ accounts: [{ name: 'a', orca: { five: 10 } }], noTable: true });
  const rn = await pick(none.deps);
  assert.deepEqual([rn.result, rn.prefix, none.orcaCalls()], ['default', '', 0]);

  const s = setup({ accounts: [{ name: 'a', orca: { five: 10 } }] });
  const r = await pick({ ...s.deps, runOrca: () => null });
  assert.deepEqual([r.result, r.prefix], ['default', '']);
  assert.ok(r.reason);
  assert.deepEqual(s.writes, []);
});
