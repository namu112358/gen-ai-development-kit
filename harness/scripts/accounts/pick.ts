/**
 * Orca につないだ Claude のアカウントのうち使用量の低いものを選び、`CLAUDE_CONFIG_DIR` の前置きを返す（Issue #820、Epic #813）。
 *
 *   node harness/scripts/accounts/pick.ts（引数なし。場所は homedir() から決める。標準出力に JSON を1つ、終了コードは常に 0）
 *
 * 入力（どれも読むだけ。書くのは launches.json だけ）
 * - 対応表 ~/.config/agent-harness/accounts.json：{ threshold5h?（既定 80）, threshold7d?（既定 90）, accounts: [{ orcaId, name, configDir }] }（configDir の先頭の `~/` はホームに展開する）
 * - 使用量の控え ~/.config/agent-harness/usage/<組織の ID>.json（ステータスラインが書く形。任意の source・status・configDir も読む）。
 *   使うのは source が probe の控えと、configDir の実パスが対応表のそのアカウントの configDir の実パスと同じ控えだけ（Issue #976。cacheMatches）
 * - 起こした数の控え ~/.config/agent-harness/usage/launches.json：[{ name, at }]（選んだら { name, at } を足す）
 * - Orca の `account list --json`（アカウントの一覧と組織の ID だけ。使用量は取り違えうるので選ぶのに使わない）。メールアドレス・組織名は読んでも出さない。
 *
 * 結果（JSON）
 * - picked：{ result, prefix（`CLAUDE_CONFIG_DIR='<dir>' `）, name, orcaId, usage, excluded }
 * - wait：{ result, prefix: '', resetAt（アカウントが選べるようになる時刻の一番早いもの、ISO。5h と 7d の両方で外れたアカウントは遅い方）, excluded }
 * - default：{ result, prefix: '', reason, excluded }（対応表・Orca が読めない、候補が無い）
 * excluded は { name, reason } の一覧。reason は outside-config-root・unreadable-claude-json・onboarding・trust・auto-mode-prompt・org-mismatch・no-usage。
 *
 * 判定は純粋関数で、ファイルの読み書きと Orca の呼び出しは deps で差し替える。CLI は import.meta.main の中だけで動く。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeLocalJson } from '../../lib/local-state.ts';
import { mainRepoRoot, orcaCliCommand } from '../../lib/worktree.ts';

export interface AccountEntry { orcaId: string; name: string; configDir: string }
export interface UsageValue { fiveHour: number | null; fiveHourResetsAt: number | null; sevenDay: number | null; sevenDayResetsAt: number | null; status: string | null; at: number; source: 'probe' | 'cache' | 'orca' }
export interface Launch { name: string; at: number }
export interface Excluded { name: string; reason: string }
export type OrcaAccounts = Map<string, { organizationUuid: string | null; usage: UsageValue | null }>;
export type PickResult =
  | { result: 'picked'; prefix: string; name: string; orcaId: string; usage: UsageValue; excluded: Excluded[] }
  | { result: 'wait'; prefix: ''; resetAt: string | null; excluded: Excluded[] }
  | { result: 'default'; prefix: ''; reason: string; excluded: Excluded[] };

const MIN = 60_000;
export const PROBE_MAX_AGE_MS = 10 * MIN;
export const CACHE_MAX_AGE_MS = 5 * MIN;
export const MIXUP_RESET_GAP_MS = 120_000;
export const LAUNCH_PENALTY = 10;
export const DEFAULT_THRESHOLD_5H = 80;
export const DEFAULT_THRESHOLD_7D = 90;
const ORCA_TIMEOUT_MS = 15_000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** 単一引用符で囲んだ前置き（中の `'` は `'\''`）。末尾に空白1つ */
export function shellPrefix(dir: string): string {
  return `CLAUDE_CONFIG_DIR='${dir.replace(/'/g, `'\\''`)}' `;
}

function usageFrom(rl: unknown, at: number | null, source: UsageValue['source'], status: unknown): UsageValue | null {
  if (!isObj(rl) || at === null) return null;
  const session = isObj(rl.session) ? rl.session : {};
  const weekly = isObj(rl.weekly) ? rl.weekly : {};
  return { fiveHour: num(session.usedPercent), fiveHourResetsAt: num(session.resetsAt), sevenDay: num(weekly.usedPercent), sevenDayResetsAt: num(weekly.resetsAt), status: str(status), at, source };
}

/** Orca の `account list --json` から、orcaId ごとの組織の ID と使用量を取り出す */
export function parseOrcaAccounts(json: unknown): OrcaAccounts {
  const out: OrcaAccounts = new Map();
  const result = isObj(json) && isObj(json.result) ? json.result : {};
  const claude = isObj(result.claude) ? result.claude : {};
  const accounts = Array.isArray(claude.accounts) ? claude.accounts : [];
  for (const a of accounts) {
    if (!isObj(a)) continue;
    const id = str(a.id);
    if (id !== null) out.set(id, { organizationUuid: str(a.organizationUuid), usage: null });
  }
  const rate = isObj(result.rateLimits) ? result.rateLimits : {};
  const set = (id: string | null, rl: unknown): void => {
    const cur = id === null ? undefined : out.get(id);
    if (id === null || cur === undefined || !isObj(rl)) return;
    cur.usage = usageFrom(rl, num(rl.updatedAt), 'orca', rl.status);
  };
  set(str(claude.activeAccountId), rate.claude);
  for (const r of Array.isArray(rate.inactiveClaudeAccounts) ? rate.inactiveClaudeAccounts : []) {
    if (isObj(r)) set(str(r.accountId), r.rateLimits);
  }
  return out;
}

/** 先頭の `~`（それだけ・`~/` で始まる）をホームに展開する。`~user/…` と相対パスは変えない */
export function expandHome(dir: string, home: string): string {
  if (dir === '~') return home;
  return dir.startsWith('~/') ? join(home, dir.slice(2)) : dir;
}

/** 実パス（無い・読めなければ null） */
export function realPathOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** 控えを使ってよいか：source が probe なら真。ほかは configDir の実パスが対応表のそのアカウントの configDir の実パスと同じときだけ（どの設定ディレクトリで書いたか分からない控えは別のアカウントの値でありうる） */
export function cacheMatches(cache: Record<string, unknown>, entry: AccountEntry, opts: { home: string; realPath: (p: string) => string | null }): boolean {
  if (cache.source === 'probe') return true;
  const dir = str(cache.configDir);
  if (dir === null) return false;
  const got = opts.realPath(expandHome(dir, opts.home));
  const want = opts.realPath(expandHome(entry.configDir, opts.home));
  return got !== null && want !== null && got === want;
}

/** 候補から外す確かめ。外す理由のコードか null（読むだけ。メールアドレス・トークンは扱わない） */
export function checkConfigDir(entry: AccountEntry, opts: { home: string; repoRoot: string; orgUuid: string | null; readText: (p: string) => string | null }): string | null {
  const configRoot = resolve(opts.home, '.config', 'agent-harness', 'claude');
  const expanded = expandHome(entry.configDir, opts.home);
  const dir = isAbsolute(expanded) ? resolve(expanded) : null;
  const rel = dir === null ? null : relative(configRoot, dir);
  if (dir === null || rel === null || rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'outside-config-root';
  let claude: unknown;
  try {
    const text = opts.readText(join(dir, '.claude.json'));
    claude = text === null ? null : JSON.parse(text);
  } catch {
    claude = null;
  }
  if (!isObj(claude)) return 'unreadable-claude-json';
  if (claude.hasCompletedOnboarding !== true) return 'onboarding';
  const projects = isObj(claude.projects) ? claude.projects : {};
  const project = projects[opts.repoRoot];
  if (!isObj(project) || project.hasTrustDialogAccepted !== true) return 'trust';
  if (claude.hasSeenAutoModeOutsideReadPrompt !== true) return 'auto-mode-prompt';
  const org = isObj(claude.oauthAccount) ? str(claude.oauthAccount.organizationUuid) : null;
  if (org === null || opts.orgUuid === null || org !== opts.orgUuid) return 'org-mismatch';
  return null;
}

/** 控えの JSON から使ってよい値を読む（cacheMatches が偽・読めなければ null）。pick.ts と probe.ts で同じ読み方にする */
export function readCacheUsage(c: unknown, entry: AccountEntry, opts: { home: string; realPath: (p: string) => string | null }): UsageValue | null {
  if (!isObj(c) || !cacheMatches(c, entry, opts)) return null;
  return usageFrom(c, num(c.at), c.source === 'probe' ? 'probe' : 'cache', c.status);
}

/** 新しい値か：5h があり、probe の控えは 10 分・ほかの控えは 5 分以内。pick.ts が使うかと probe.ts が問い合わせを省くかを同じ規則で決める */
export function isFreshUsage(v: UsageValue | null | undefined, now: number): v is UsageValue {
  return !!v && v.fiveHour !== null && now - v.at <= (v.source === 'probe' ? PROBE_MAX_AGE_MS : CACHE_MAX_AGE_MS);
}

/** 取り違えの疑い：問い合わせでない2つの控えで 5h が同じ・5h のリセットの差が 120 秒以内・7d が同じ（null 同士を含む） */
const sameLooking = (a: UsageValue, b: UsageValue): boolean =>
  a.fiveHour === b.fiveHour &&
  a.sevenDay === b.sevenDay &&
  (a.fiveHourResetsAt === null || b.fiveHourResetsAt === null ? a.fiveHourResetsAt === b.fiveHourResetsAt : Math.abs(a.fiveHourResetsAt - b.fiveHourResetsAt) <= MIXUP_RESET_GAP_MS);

/** アカウントごとに使う値を選ぶ。取り元の順は 10 分以内の probe の控え → 5 分以内のほかの控え（Orca の値は使わない）。取り違えの値は飛ばす */
export function chooseUsage(input: { accounts: AccountEntry[]; cache: Map<string, UsageValue | null>; now: number }): Map<string, UsageValue | null> {
  const cands = new Map<string, UsageValue[]>();
  for (const a of input.accounts) {
    const c = input.cache.get(a.orcaId);
    cands.set(a.orcaId, isFreshUsage(c, input.now) ? [c] : []);
  }
  const out = new Map<string, UsageValue | null>();
  for (const a of input.accounts) {
    const picked = (cands.get(a.orcaId) ?? []).find((v) => {
      if (v.source === 'probe') return true;
      for (const [id, others] of cands) {
        if (id === a.orcaId) continue;
        if (others.some((o) => o.source !== 'probe' && sameLooking(v, o))) return false;
      }
      return true;
    });
    out.set(a.orcaId, picked ?? null);
  }
  return out;
}

/** リセット時刻（ミリ秒）を過ぎた（ちょうどを含む）5h・7d は 0% とみなした値。リセット時刻が null の値・7d が null はそのまま */
export function effectiveUsage(u: UsageValue, now: number): { fiveHour: number; sevenDay: number | null } {
  const fiveHour = u.fiveHourResetsAt !== null && u.fiveHourResetsAt <= now ? 0 : (u.fiveHour ?? 0);
  const sevenDay = u.sevenDay !== null && u.sevenDayResetsAt !== null && u.sevenDayResetsAt <= now ? 0 : u.sevenDay;
  return { fiveHour, sevenDay };
}

/** 候補から選ぶ。使える値が無いアカウントは no-usage で外す。リセット済みの枠は 0% として、5h・7d のしきい値と順番を決める */
export function pickAccount(input: { accounts: AccountEntry[]; threshold5h: number; threshold7d: number; usage: Map<string, UsageValue | null>; launches: Launch[]; excluded: Excluded[]; now: number }): PickResult {
  const excluded = [...input.excluded];
  const cands: { a: AccountEntry; u: UsageValue; e: { fiveHour: number; sevenDay: number | null }; index: number }[] = [];
  input.accounts.forEach((a, index) => {
    const u = input.usage.get(a.orcaId) ?? null;
    if (u === null || u.fiveHour === null) excluded.push({ name: a.name, reason: 'no-usage' });
    else cands.push({ a, u, e: effectiveUsage(u, input.now), index });
  });
  if (cands.length === 0) return { result: 'default', prefix: '', reason: 'no-candidates', excluded };
  const over5 = (c: (typeof cands)[number]): boolean => c.e.fiveHour >= input.threshold5h;
  const over7 = (c: (typeof cands)[number]): boolean => c.e.sevenDay !== null && c.e.sevenDay >= input.threshold7d;
  const open = cands.filter((c) => !over5(c) && !over7(c) && c.u.status !== 'rejected');
  if (open.length === 0) {
    // アカウントごとに、外れた理由の枠のリセット時刻（両方なら遅い方）。null の枠は数えない
    const times: number[] = [];
    for (const c of cands) {
      const t: (number | null)[] = [];
      if (over5(c)) t.push(c.u.fiveHourResetsAt);
      if (over7(c)) t.push(c.u.sevenDayResetsAt);
      if (t.length === 0) t.push(c.u.fiveHourResetsAt);
      if (t.every((v) => v !== null)) times.push(Math.max(...(t as number[])));
    }
    return { result: 'wait', prefix: '', resetAt: times.length === 0 ? null : new Date(Math.min(...times)).toISOString(), excluded };
  }
  const score = (c: (typeof cands)[number]): number =>
    Math.max(c.e.fiveHour, c.e.sevenDay ?? c.e.fiveHour) + LAUNCH_PENALTY * input.launches.filter((l) => l.name === c.a.name && l.at > c.u.at).length;
  open.sort((x, y) => score(x) - score(y) || (x.e.sevenDay ?? 0) - (y.e.sevenDay ?? 0) || x.index - y.index);
  const best = open[0]!;
  return { result: 'picked', prefix: shellPrefix(resolve(best.a.configDir)), name: best.a.name, orcaId: best.a.orcaId, usage: best.u, excluded };
}

export interface PickDeps {
  home: string;
  /** リポジトリの本体のパス。関数なら対応表を読んだ後で呼ぶ（git を呼ばずに済む場面のため） */
  repoRoot: string | (() => string);
  now: number;
  readText: (p: string) => string | null;
  runOrca: () => string | null;
  writeJson: (p: string, value: unknown) => void;
  /** 実パス（無ければ null）。既定は realpathSync */
  realPath?: (p: string) => string | null;
}

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const dflt = (reason: string): PickResult => ({ result: 'default', prefix: '', reason, excluded: [] });

/** 対応表（accounts.json を読んだ JSON）から、アカウントの一覧としきい値を取り出す。pick.ts と probe.ts で同じ読み方にする */
export function parseAccountsTable(json: unknown): { accounts: AccountEntry[]; threshold5h: number; threshold7d: number } {
  const rawAccounts = isObj(json) && Array.isArray(json.accounts) ? json.accounts : [];
  const accounts: AccountEntry[] = [];
  for (const a of rawAccounts) {
    if (isObj(a) && str(a.orcaId) && str(a.name) && str(a.configDir)) accounts.push({ orcaId: a.orcaId as string, name: a.name as string, configDir: a.configDir as string });
  }
  const threshold5h = isObj(json) && num(json.threshold5h) !== null ? (json.threshold5h as number) : DEFAULT_THRESHOLD_5H;
  const threshold7d = isObj(json) && num(json.threshold7d) !== null ? (json.threshold7d as number) : DEFAULT_THRESHOLD_7D;
  return { accounts, threshold5h, threshold7d };
}

/** 対応表を読む → 無ければ default → 本体のパスと Orca を読む → 選ぶ */
export function runPick(deps: PickDeps): PickResult {
  const base = join(deps.home, '.config', 'agent-harness');
  const table = parseJson(deps.readText(join(base, 'accounts.json')));
  const parsed = parseAccountsTable(table);
  if (parsed.accounts.length === 0) return dflt('no-accounts-table');
  const { threshold5h, threshold7d } = parsed;
  const accounts = parsed.accounts.map((a) => ({ ...a, configDir: expandHome(a.configDir, deps.home) }));
  const realPath = deps.realPath ?? realPathOrNull;

  let repoRoot: string;
  try {
    repoRoot = typeof deps.repoRoot === 'function' ? deps.repoRoot() : deps.repoRoot;
  } catch {
    return dflt('no-repo-root');
  }
  const orcaJson = parseJson(deps.runOrca());
  if (orcaJson === null) return dflt('orca-unreadable');
  const orca = parseOrcaAccounts(orcaJson);

  const excluded: Excluded[] = [];
  const usable: AccountEntry[] = [];
  const cache = new Map<string, UsageValue | null>();
  for (const a of accounts) {
    const org = orca.get(a.orcaId)?.organizationUuid ?? null;
    const reason = checkConfigDir(a, { home: deps.home, repoRoot, orgUuid: org, readText: deps.readText });
    if (reason !== null) {
      excluded.push({ name: a.name, reason });
      continue;
    }
    usable.push(a);
    if (org !== null && /^[\w.-]+$/.test(org)) {
      cache.set(a.orcaId, readCacheUsage(parseJson(deps.readText(join(base, 'usage', `${org}.json`))), a, { home: deps.home, realPath }));
    }
  }
  const usage = chooseUsage({ accounts: usable, cache, now: deps.now });
  const launchesPath = join(base, 'usage', 'launches.json');
  const rawLaunches = parseJson(deps.readText(launchesPath));
  const launches: Launch[] = [];
  for (const l of Array.isArray(rawLaunches) ? rawLaunches : []) {
    if (isObj(l) && typeof l.name === 'string' && num(l.at) !== null) launches.push({ name: l.name, at: l.at as number });
  }
  const r = pickAccount({ accounts: usable, threshold5h, threshold7d, usage, launches, excluded, now: deps.now });
  if (r.result === 'picked') deps.writeJson(launchesPath, [...launches, { name: r.name, at: deps.now }]);
  return r;
}

export function runOrcaCli(): string | null {
  const r = spawnSync(orcaCliCommand(process.platform, process.env), ['account', 'list', '--json'], { shell: false, encoding: 'utf8', timeout: ORCA_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
  return r.error || r.status !== 0 ? null : String(r.stdout ?? '');
}

if (import.meta.main) {
  let out: PickResult;
  try {
    out = runPick({
      home: homedir(),
      repoRoot: () => mainRepoRoot(),
      now: Date.now(),
      readText: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return null;
        }
      },
      runOrca: runOrcaCli,
      writeJson: (p, v) => writeLocalJson(p, v),
    });
  } catch (e) {
    out = dflt(`error: ${(e as Error).message}`);
  }
  console.log(JSON.stringify(out));
}
