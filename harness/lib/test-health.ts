import type { HarnessConfig } from './config.ts';
import type { GitHub } from './github.ts';
import { collectFlakyCi, jobsOf, workflowRuns, type FlakyCiRun, type Run } from './qa-retro.ts';

/**
 * 保守の観測（harness/scripts/observe.ts）のテストの健康：遅いテスト、不安定なテスト（同じ head で失敗の後に成功）、
 * mutation で生き残ったミュータント。test-prune の skill も材料として使う共有の集計。
 * 読む・数える純粋関数と、GitHub から集める collectCiHealth（GET だけ）に分ける。
 * 不安定なテストの集め方は harness/lib/qa-retro.ts の collectFlakyCi と同じ（2か所に書かない）。
 * 生き残りは ci ワークフローの mutation ジョブのログの `survived\t<file>:<line>\t<operator>`（harness/scripts/mutate.ts が出す形）から読む。
 */

export type Unavailable = { available: false; reason: string };

export interface JunitCase {
  name: string;
  /** リポジトリのルートからの / 区切りのパス（root の外ならそのまま / 区切り）。無ければ null */
  file: string | null;
  seconds: number;
}

export interface SlowTests {
  available: true;
  totalTests: number;
  /** 遅い順（top で切る） */
  tests: { name: string; file: string | null; seconds: number }[];
  /** ファイルごとの合計の遅い順（top で切る。file の無いテストは '(不明)'） */
  files: { file: string; seconds: number; tests: number }[];
  truncated: { tests: number; files: number };
}

export interface SurvivedMutant {
  file: string;
  line: number;
  operator: string;
}

/** mutation ジョブ1つのログ。log が null はログが読めなかった */
export interface MutationRunLog {
  runId: number;
  url: string;
  headSha: string;
  createdAt: string;
  pr: number | null;
  log: string | null;
  /** ログが読めなかった理由（log が null のとき） */
  error?: string;
}

export interface MutantsSection {
  available: true;
  /** 読んだ mutation ジョブの数（読めなかったものを含む） */
  runs: number;
  unreadableRuns: number;
  /** ログが読めなかった理由（最初の1つ。読めなかった実行があるときだけ） */
  unreadableReason?: string;
  total: number;
  truncated: number;
  items: (SurvivedMutant & { pr: number | null; runUrl: string; headSha: string; createdAt: string })[];
}

export interface FlakyTestsSection {
  available: true;
  /** 失敗の後に成功した実行（FlakyCiRun）の数 */
  runs: number;
  /** ログが読めずテスト名が分からなかったジョブの数 */
  unreadableLogs: number;
  total: number;
  truncated: number;
  /** runs は失敗した実行の URL */
  items: { name: string; count: number; kinds: ('rerun' | 'separate-run')[]; runs: string[] }[];
}

const UNKNOWN_FILE = '(不明)';

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function decodeXml(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? decodeXml(m[1]!) : null;
}

/** Node の junit の出力（`<testcase name time file>`）を読む。file は root からの相対にする */
export function parseJunit(xml: string, root?: string): JunitCase[] {
  const base = root ? root.replace(/\\/g, '/').replace(/\/?$/, '/') : null;
  const out: JunitCase[] = [];
  for (const m of xml.matchAll(/<testcase\b[^>]*>/g)) {
    const tag = m[0];
    const name = attr(tag, 'name') ?? '';
    const time = Number(attr(tag, 'time') ?? '0');
    let file = attr(tag, 'file');
    if (file !== null) {
      file = file.replace(/\\/g, '/');
      if (base && file.toLowerCase().startsWith(base.toLowerCase())) file = file.slice(base.length);
    }
    out.push({ name, file, seconds: Number.isFinite(time) ? time : 0 });
  }
  return out;
}

/** テストごとの遅い順と、ファイルごとの合計の遅い順 */
export function slowTests(cases: JunitCase[], top: number): SlowTests {
  const tests = [...cases].sort((a, b) => b.seconds - a.seconds || byName(a.file ?? '', b.file ?? '') || byName(a.name, b.name));
  const files = new Map<string, { file: string; seconds: number; tests: number }>();
  for (const c of cases) {
    const key = c.file ?? UNKNOWN_FILE;
    const f = files.get(key) ?? { file: key, seconds: 0, tests: 0 };
    f.seconds += c.seconds;
    f.tests++;
    files.set(key, f);
  }
  const fileList = [...files.values()].map((f) => ({ ...f, seconds: Math.round(f.seconds * 1e6) / 1e6 })).sort((a, b) => b.seconds - a.seconds || byName(a.file, b.file));
  return {
    available: true,
    totalTests: cases.length,
    tests: tests.slice(0, top).map((c) => ({ name: c.name, file: c.file, seconds: c.seconds })),
    files: fileList.slice(0, top),
    truncated: { tests: Math.max(0, tests.length - top), files: Math.max(0, fileList.length - top) },
  };
}

/** mutation のログから生き残ったミュータントを読む（色と先頭の時刻は外す） */
export function parseSurvivedMutants(log: string): SurvivedMutant[] {
  const out: SurvivedMutant[] = [];
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/, '');
    const m = line.match(/^survived\t(.+):(\d+)\t(.+?)\s*$/);
    if (m) out.push({ file: m[1]!, line: Number(m[2]), operator: m[3]! });
  }
  return out;
}

/** 同じ箇所（file:line:operator）は新しい実行だけ残し、今は無いファイルを除いて、新しい順に並べる */
export function survivedMutants(runs: MutationRunLog[], exists: (file: string) => boolean, top: number): MutantsSection {
  const latest = new Map<string, MutantsSection['items'][number]>();
  let unreadableRuns = 0;
  let unreadableReason: string | undefined;
  for (const r of runs) {
    if (r.log === null) {
      unreadableRuns++;
      unreadableReason ??= r.error;
      continue;
    }
    for (const m of parseSurvivedMutants(r.log)) {
      if (!exists(m.file)) continue;
      const key = `${m.file}:${m.line}:${m.operator}`;
      const prev = latest.get(key);
      if (prev && new Date(prev.createdAt).getTime() >= new Date(r.createdAt).getTime()) continue;
      latest.set(key, { ...m, pr: r.pr, runUrl: r.url, headSha: r.headSha, createdAt: r.createdAt });
    }
  }
  const all = [...latest.values()].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() || byName(a.file, b.file) || a.line - b.line || byName(a.operator, b.operator),
  );
  const items = all.slice(0, top);
  return { available: true, runs: runs.length, unreadableRuns, ...(unreadableReason ? { unreadableReason } : {}), total: all.length, truncated: all.length - items.length, items };
}

/** 失敗の後に成功した実行を、失敗したテスト名ごとにまとめる（名前が読めなかったジョブは数えない） */
export function flakyTests(flaky: FlakyCiRun[], unreadableLogs: number, top: number): FlakyTestsSection {
  const byTest = new Map<string, FlakyTestsSection['items'][number]>();
  for (const f of flaky) {
    const names = new Set(f.jobs.flatMap((j) => j.testNames ?? []));
    for (const name of names) {
      const item = byTest.get(name) ?? { name, count: 0, kinds: [], runs: [] };
      item.count++;
      if (!item.kinds.includes(f.kind)) item.kinds.push(f.kind);
      if (!item.runs.includes(f.failed.url)) item.runs.push(f.failed.url);
      byTest.set(name, item);
    }
  }
  const all = [...byTest.values()].sort((a, b) => b.count - a.count || byName(a.name, b.name));
  const items = all.slice(0, top);
  return { available: true, runs: flaky.length, unreadableLogs, total: all.length, truncated: all.length - items.length, items };
}

/** mutation のログを読む実行の上限（新しい順） */
const MAX_MUTATION_RUNS = 100;
const MUTATION_JOB = 'mutation';

/**
 * 期間内の CI の実行から、不安定なテストと生き残ったミュータントを集める（GET だけ）。
 * 実行の一覧（workflowRuns）は1回だけ取り、不安定（collectFlakyCi）とミュータントの両方に使う。
 * mutation ジョブは pull_request の実行にしか無いので、pull_request（event が無い応答は対象）の実行の新しいものから MAX_MUTATION_RUNS 件まで読む
 */
export async function collectCiHealth(
  gh: GitHub,
  config: HarnessConfig,
  period: { since: Date; until: Date },
  opts: { top: number; exists: (file: string) => boolean },
): Promise<{ flaky: FlakyTestsSection; mutants: MutantsSection; truncated: string[] }> {
  const listed = await workflowRuns(gh, period);
  const { flaky, unreadableLogs, runsTruncated } = await collectFlakyCi(gh, config, period, listed);
  const truncated = [...runsTruncated];

  const candidates = listed.runs
    .filter((r: Run) => (r.event === undefined || r.event === 'pull_request') && r.status === 'completed')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || b.id - a.id);
  if (candidates.length > MAX_MUTATION_RUNS) truncated.push(`mutation のログ（新しい ${MAX_MUTATION_RUNS} 件の実行まで。${candidates.length} 件中）`);
  const logs: MutationRunLog[] = [];
  for (const r of candidates.slice(0, MAX_MUTATION_RUNS)) {
    const jobs = await jobsOf(gh, `/actions/runs/${r.id}/jobs`);
    for (const j of jobs.filter((x) => x.name === MUTATION_JOB && x.conclusion !== 'skipped' && x.conclusion !== null)) {
      let log: string | null = null;
      let error: string | undefined;
      try {
        const got = await gh.get<unknown>(`/actions/jobs/${j.id}/logs`, { raw: true });
        if (typeof got === 'string') log = got;
        else error = 'ログが文字列で返りませんでした';
      } catch (e) {
        error = (e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0]!.slice(0, 300);
      }
      logs.push({ runId: r.id, url: r.html_url, headSha: r.head_sha, createdAt: r.created_at, pr: r.pull_requests?.[0]?.number ?? null, log, ...(error ? { error } : {}) });
    }
  }
  return { flaky: flakyTests(flaky, unreadableLogs, opts.top), mutants: survivedMutants(logs, opts.exists, opts.top), truncated };
}
