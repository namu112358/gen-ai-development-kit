/**
 * 各アカウントの設定ディレクトリで Claude を1回呼び、応答の rate_limit_event から 5h・7d の使用量を控えに書く（Issue #821、Epic #813）。
 *
 *   node harness/scripts/accounts/probe.ts（引数なし。場所は homedir() から決める。標準出力に JSON を1つ、終了コードは常に 0）
 *
 * 入力
 * - 対応表 ~/.config/agent-harness/accounts.json（pick.ts の parseAccountsTable と同じ読み方）
 * - Orca の `account list --json`（組織の ID と、ずれの確かめに使う Orca の 5h）
 * - 使用量の控え ~/.config/agent-harness/usage/<組織の ID>.json（`at` が 10 分以内なら問い合わせない。取り元は問わない）
 * - `.claude.json`（候補から外す確かめ pick.ts の checkConfigDir が読むだけ。書かない）
 *
 * 書くファイル：問い合わせたアカウントの usage/<組織の ID>.json だけ
 *   { at, session: { usedPercent, resetsAt }, weekly: { usedPercent, resetsAt }, status, source: 'probe' }（resetsAt はミリ秒）
 *
 * 結果（JSON）
 * - done：{ result, probed: [{ name, fiveHour, sevenDay, status }], skipped: [{ name, reason }], failed: [{ name, reason }], mismatches: [{ name, probe, orca }] }
 *   skipped の reason は pick.ts の excluded と同じコード・fresh・bad-org-id。failed の reason は timeout・no-rate-limit-event・spawn-failed・write-failed。
 *   mismatches は問い合わせた 5h と Orca の 5h が 20 ポイント以上ずれたもの。
 * - skipped：{ result, reason }（no-accounts-table・no-repo-root・orca-unreadable・error: <message>）
 * メールアドレス・トークン・組織名・claude の出力の本文は出さない。
 *
 * 判定は純粋関数で、ファイル・Orca・claude の呼び出しは deps で差し替える。CLI は import.meta.main の中だけで動く。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeLocalJson } from '../../lib/local-state.ts';
import { mainRepoRoot } from '../../lib/worktree.ts';
import { PROBE_MAX_AGE_MS, checkConfigDir, parseAccountsTable, parseOrcaAccounts, runOrcaCli } from './pick.ts';

export const PROBE_TIMEOUT_MS = 90_000;
export const MISMATCH_POINTS = 20;

export interface ProbeUsage { fiveHour: number; fiveHourResetsAt: number | null; sevenDay: number | null; sevenDayResetsAt: number | null; status: string | null }
export interface ProbeDeps {
  home: string;
  repoRoot: string | (() => string);
  now: number;
  readText: (p: string) => string | null;
  runOrca: () => string | null;
  runClaude: (configDir: string) => { stdout: string; error: 'timeout' | 'spawn-failed' | null };
  writeJson: (p: string, v: unknown) => void;
}
export type ProbeResult =
  | { result: 'skipped'; reason: string }
  | {
      result: 'done';
      probed: { name: string; fiveHour: number; sevenDay: number | null; status: string | null }[];
      skipped: { name: string; reason: string }[];
      failed: { name: string; reason: string }[];
      mismatches: { name: string; probe: number; orca: number }[];
    };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** stream-json の最後の rate_limit_event から使用量を読む。無い・壊れている・5h が読めなければ null */
export function parseProbeOutput(text: string): ProbeUsage | null {
  let info: Record<string, unknown> | null = null;
  for (const line of text.split('\n')) {
    const v = parseJson(line.trim() === '' ? null : line);
    if (isObj(v) && v.type === 'rate_limit_event' && isObj(v.rate_limit_info)) info = v.rate_limit_info;
  }
  if (info === null) return null;
  const windows = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
  const win = (w: unknown): { percent: number; resetsAt: number | null } | null => {
    const u = isObj(w) ? num(w.utilization) : null;
    if (u === null) return null;
    const r = num((w as Record<string, unknown>).resetsAt);
    return { percent: Math.round(u * 100), resetsAt: r === null ? null : r * 1000 };
  };
  const five = win(windows.five_hour);
  if (five === null) return null;
  const seven = win(windows.seven_day);
  return {
    fiveHour: five.percent,
    fiveHourResetsAt: five.resetsAt,
    sevenDay: seven?.percent ?? null,
    sevenDayResetsAt: seven?.resetsAt ?? null,
    status: typeof info.status === 'string' && info.status !== '' ? info.status : null,
  };
}

/** 対応表 → 本体のパス → Orca → アカウントごとに（外れる・新しい控えは飛ばし）1つずつ問い合わせて控えを書く */
export function runProbe(deps: ProbeDeps): ProbeResult {
  const base = join(deps.home, '.config', 'agent-harness');
  const { accounts } = parseAccountsTable(parseJson(deps.readText(join(base, 'accounts.json'))));
  if (accounts.length === 0) return { result: 'skipped', reason: 'no-accounts-table' };
  let repoRoot: string;
  try {
    repoRoot = typeof deps.repoRoot === 'function' ? deps.repoRoot() : deps.repoRoot;
  } catch {
    return { result: 'skipped', reason: 'no-repo-root' };
  }
  const orcaJson = parseJson(deps.runOrca());
  if (orcaJson === null) return { result: 'skipped', reason: 'orca-unreadable' };
  const orca = parseOrcaAccounts(orcaJson);

  const out: Extract<ProbeResult, { result: 'done' }> = { result: 'done', probed: [], skipped: [], failed: [], mismatches: [] };
  for (const a of accounts) {
    const org = orca.get(a.orcaId)?.organizationUuid ?? null;
    const reason = checkConfigDir(a, { home: deps.home, repoRoot, orgUuid: org, readText: deps.readText });
    if (reason !== null) {
      out.skipped.push({ name: a.name, reason });
      continue;
    }
    if (org === null || !/^[\w.-]+$/.test(org)) {
      out.skipped.push({ name: a.name, reason: 'bad-org-id' });
      continue;
    }
    const path = join(base, 'usage', `${org}.json`);
    const cached = parseJson(deps.readText(path));
    const at = isObj(cached) ? num(cached.at) : null;
    if (at !== null && deps.now - at <= PROBE_MAX_AGE_MS) {
      out.skipped.push({ name: a.name, reason: 'fresh' });
      continue;
    }
    const run = deps.runClaude(a.configDir);
    if (run.error !== null) {
      out.failed.push({ name: a.name, reason: run.error });
      continue;
    }
    const u = parseProbeOutput(run.stdout);
    if (u === null) {
      out.failed.push({ name: a.name, reason: 'no-rate-limit-event' });
      continue;
    }
    try {
      deps.writeJson(path, {
        at: deps.now,
        session: { usedPercent: u.fiveHour, resetsAt: u.fiveHourResetsAt },
        weekly: { usedPercent: u.sevenDay, resetsAt: u.sevenDayResetsAt },
        status: u.status,
        source: 'probe',
      });
    } catch {
      out.failed.push({ name: a.name, reason: 'write-failed' });
      continue;
    }
    out.probed.push({ name: a.name, fiveHour: u.fiveHour, sevenDay: u.sevenDay, status: u.status });
    const orcaFive = orca.get(a.orcaId)?.usage?.fiveHour ?? null;
    if (orcaFive !== null && Math.abs(orcaFive - u.fiveHour) >= MISMATCH_POINTS) out.mismatches.push({ name: a.name, probe: u.fiveHour, orca: orcaFive });
  }
  return out;
}

/** 本物の claude を、一時ディレクトリを cwd に、そのアカウントの設定ディレクトリで1回呼ぶ */
function runClaudeCli(configDir: string): { stdout: string; error: 'timeout' | 'spawn-failed' | null } {
  const cwd = mkdtempSync(join(tmpdir(), 'agent-harness-probe-'));
  try {
    const r = spawnSync('claude', ['-p', '1', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'], {
      shell: false,
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      cwd,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    return { stdout: String(r.stdout ?? ''), error: r.error ? (code === 'ETIMEDOUT' ? 'timeout' : 'spawn-failed') : null };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  let out: ProbeResult;
  try {
    out = runProbe({
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
      runClaude: runClaudeCli,
      writeJson: (p, v) => writeLocalJson(p, v),
    });
  } catch (e) {
    out = { result: 'skipped', reason: `error: ${(e as Error).message}` };
  }
  console.log(JSON.stringify(out));
}
