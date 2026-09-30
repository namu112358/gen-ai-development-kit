import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessConfig } from './config.ts';
import type { GitHub } from './github.ts';
import { HOTSPOT_LOG_ARGS, countLines, parseNumstat, rankHotspots, type Hotspot } from './hotspot.ts';
import { buildDocsInventory, checkDoc, isDocTarget, type DocFinding } from './observe-docs.ts';
import { collectCiHealth, parseJunit, slowTests, type FlakyTestsSection, type MutantsSection, type SlowTests, type Unavailable } from './test-health.ts';

/**
 * 保守の観測（harness/scripts/observe.ts）のまとめ。docs の照合（observe-docs.ts）・ホットスポット（hotspot.ts）・
 * テストの健康（test-health.ts）を1回分の JSON（version 1）に組み、人が読む要約と、前回の JSON との差を作る。
 * 読む部分（git・ファイル・GitHub）は ObserveIo で受け取る。GitHub は GET だけ、出力は OS の一時ディレクトリに書く（リポジトリにも GitHub にも書かない）。
 * LLM は呼ばない。判断（直すか・Issue にするか）は人か、次の段階の skill が行う。
 */

export interface ObserveOptions {
  days: number;
  top: number;
  junit: string | null;
  runTests: boolean;
  previous: string | null;
  offline: boolean;
}

export interface ObserveReport {
  version: 1;
  generatedAt: string;
  /** 今のコミット */
  head: string;
  period: { days: number; since: string; until: string };
  top: number;
  docs: { available: true; total: number; truncated: number; byKind: Record<string, number>; items: DocFinding[] } | Unavailable;
  hotspots: { available: true; total: number; truncated: number; items: Hotspot[] } | Unavailable;
  slowTests: SlowTests | Unavailable;
  flakyTests: FlakyTestsSection | Unavailable;
  mutants: MutantsSection | Unavailable;
  /** 打ち切り・読めなかったものなど */
  notes: string[];
  diff?: ObserveDiff;
}

export const OBSERVE_SECTIONS = ['docs', 'hotspots', 'slowTests', 'flakyTests', 'mutants'] as const;
export type ObserveSection = (typeof OBSERVE_SECTIONS)[number];

export interface ObserveDiff {
  previousGeneratedAt: string;
  /** どちらかが読めない節は null */
  sections: Record<ObserveSection, { added: string[]; removed: string[] } | null>;
}

export interface ObserveIo {
  config: HarnessConfig;
  now: Date;
  gitFiles(): string[];
  gitLog(args: string[]): string;
  head(): string;
  /** ルートからの相対パスで読む。読めなければ null */
  readText(path: string): string | null;
  /** null は GitHub を読まない（--offline など。理由は offlineReason） */
  gh: GitHub | null;
  /** gh が null の理由（無ければ --offline） */
  offlineReason?: string;
  /** junit の XML か、読めない理由 */
  junit(): Promise<string | { reason: string }>;
  /** リポジトリのルート（junit の file を相対にする。無ければそのまま） */
  root?: string;
}

const DAY = 86400_000;

// --- 引数 ---

export function parseObserveArgs(args: string[]): { ok: true; value: ObserveOptions } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const value: ObserveOptions = { days: 30, top: 20, junit: null, runTests: false, previous: null, offline: false };
  const seen = new Set<string>();
  const positive = (name: string, v: string | undefined): number => {
    if (v === undefined || !/^[1-9]\d*$/.test(v)) {
      errors.push(`${name} は正の整数で書いてください`);
      return 0;
    }
    return Number(v);
  };
  const text = (name: string, v: string | undefined): string | null => {
    if (v === undefined || v === '' || v.startsWith('--')) {
      errors.push(`${name} にはパスを渡してください`);
      return null;
    }
    return v;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (seen.has(a)) errors.push(`${a} が2回あります`);
    seen.add(a);
    if (a === '--days') value.days = positive(a, args[++i]);
    else if (a === '--top') value.top = positive(a, args[++i]);
    else if (a === '--junit') value.junit = text(a, args[++i]);
    else if (a === '--previous') value.previous = text(a, args[++i]);
    else if (a === '--run-tests') value.runTests = true;
    else if (a === '--offline') value.offline = true;
    else errors.push(`知らない引数です: ${a}`);
  }
  if (seen.has('--junit') && value.runTests) errors.push('--junit と --run-tests は同時に渡せません');
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

// --- 集める ---

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 300);

/** 1回分の観測。GitHub の節は失敗しても、その節を読めない扱いにしてほかの節は出す */
export async function observe(io: ObserveIo, opts: ObserveOptions, previous?: ObserveReport | null): Promise<ObserveReport> {
  const until = io.now;
  const since = new Date(until.getTime() - opts.days * DAY);
  const notes: string[] = [];
  const files = io.gitFiles().map((f) => f.replace(/\\/g, '/'));
  const fileSet = new Set(files);

  // docs の照合
  let docs: ObserveReport['docs'];
  try {
    const inv = buildDocsInventory({ files, readText: io.readText, config: io.config });
    const all = files.filter(isDocTarget).sort().flatMap((f) => checkDoc(f, io.readText(f) ?? '', inv));
    const byKind: Record<string, number> = {};
    for (const d of all) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    const items = all.slice(0, opts.top);
    docs = { available: true, total: all.length, truncated: all.length - items.length, byKind, items };
  } catch (e) {
    docs = { available: false, reason: reasonOf(e) };
  }

  // ホットスポット
  let hotspots: ObserveReport['hotspots'];
  try {
    const churn = parseNumstat(io.gitLog(HOTSPOT_LOG_ARGS(since.toISOString())));
    const lines = new Map<string, number>();
    for (const c of churn) {
      if (!fileSet.has(c.file)) continue;
      const text = io.readText(c.file);
      if (text !== null) lines.set(c.file, countLines(text));
    }
    hotspots = { available: true, ...rankHotspots(churn, lines, { top: opts.top, exclude: io.config.classification.sizeExclude ?? [] }) };
  } catch (e) {
    hotspots = { available: false, reason: reasonOf(e) };
  }

  // 遅いテスト
  let slow: ObserveReport['slowTests'];
  try {
    const junit = await io.junit();
    if (typeof junit === 'string') {
      const cases = parseJunit(junit, io.root);
      slow = cases.length > 0 ? slowTests(cases, opts.top) : { available: false, reason: 'junit にテストがありません' };
    } else slow = { available: false, reason: junit.reason };
  } catch (e) {
    slow = { available: false, reason: reasonOf(e) };
  }

  // 不安定なテスト・生き残ったミュータント（GitHub）
  let flakyTests: ObserveReport['flakyTests'];
  let mutants: ObserveReport['mutants'];
  if (io.gh === null) {
    const reason = io.offlineReason ?? '--offline のため GitHub を読んでいません';
    flakyTests = { available: false, reason };
    mutants = { available: false, reason };
  } else {
    try {
      const ci = await collectCiHealth(io.gh, io.config, { since, until }, { top: opts.top, exists: (f) => fileSet.has(f) });
      flakyTests = ci.flaky;
      mutants = ci.mutants;
      notes.push(...ci.truncated.map((t) => `打ち切り：${t}`));
    } catch (e) {
      const reason = `GitHub を読めません：${reasonOf(e)}`;
      flakyTests = { available: false, reason };
      mutants = { available: false, reason };
    }
  }

  const report: ObserveReport = {
    version: 1,
    generatedAt: io.now.toISOString(),
    head: io.head(),
    period: { days: opts.days, since: since.toISOString(), until: until.toISOString() },
    top: opts.top,
    docs,
    hotspots,
    slowTests: slow,
    flakyTests,
    mutants,
    notes,
  };
  if (previous) report.diff = diffReports(previous, report);
  return report;
}

// --- 差 ---

/** 節ごとの項目の鍵（前回との差に使う。行番号のずれで別物にならないよう、docs は行を含めない）。読めない節は null */
export function itemKeys(report: ObserveReport, section: ObserveSection): string[] | null {
  switch (section) {
    case 'docs':
      return report.docs.available ? report.docs.items.map((d) => `${d.kind} ${d.file} ${d.name}`) : null;
    case 'hotspots':
      return report.hotspots.available ? report.hotspots.items.map((h) => h.file) : null;
    case 'slowTests':
      return report.slowTests.available ? report.slowTests.tests.map((t) => `${t.file ?? '(不明)'} ${t.name}`) : null;
    case 'flakyTests':
      return report.flakyTests.available ? report.flakyTests.items.map((t) => t.name) : null;
    case 'mutants':
      return report.mutants.available ? report.mutants.items.map((m) => `${m.file}:${m.line} ${m.operator}`) : null;
  }
}

/** 前回との差（節ごとに、新しく出た鍵と消えた鍵。どちらも上位 top の中での比較） */
export function diffReports(previous: ObserveReport, current: ObserveReport): ObserveDiff {
  const sections = {} as ObserveDiff['sections'];
  for (const s of OBSERVE_SECTIONS) {
    const before = previous[s] === undefined ? null : itemKeys(previous, s);
    const after = itemKeys(current, s);
    if (before === null || after === null) {
      sections[s] = null;
      continue;
    }
    const b = new Set(before);
    const a = new Set(after);
    sections[s] = { added: after.filter((k) => !b.has(k)), removed: before.filter((k) => !a.has(k)) };
  }
  return { previousGeneratedAt: previous.generatedAt, sections };
}

// --- 要約 ---

const TITLES: Record<ObserveSection, string> = {
  docs: 'docs の照合（実在しない名前・リンク）',
  hotspots: 'ホットスポット（変更回数 × 行数）',
  slowTests: '遅いテスト',
  flakyTests: '不安定なテスト（同じ head で失敗の後に成功）',
  mutants: '生き残ったミュータント',
};

const truncatedNote = (n: number): string => (n > 0 ? `（ほか ${n} 件は省略）` : '');

/** 人が読む要約 */
export function renderSummary(report: ObserveReport): string {
  const out: string[] = [];
  out.push(`# 保守の観測（${report.generatedAt}、head ${report.head.slice(0, 12)}、直近 ${report.period.days} 日、各節の上限 ${report.top} 件）`);

  const section = (s: ObserveSection, body: () => string[]): void => {
    out.push('', `## ${TITLES[s]}`);
    const v = report[s];
    if (!v.available) {
      out.push(`読めません：${v.reason}`);
      return;
    }
    out.push(...body());
  };

  section('docs', () => {
    const d = report.docs as Extract<ObserveReport['docs'], { available: true }>;
    const kinds = Object.entries(d.byKind).map(([k, n]) => `${k} ${n}`).join('、');
    return [`${d.total} 件${kinds ? `（${kinds}）` : ''}${truncatedNote(d.truncated)}`, ...d.items.map((f) => `- ${f.file}:${f.line}  [${f.kind}] ${f.name}`)];
  });
  section('hotspots', () => {
    const h = report.hotspots as Extract<ObserveReport['hotspots'], { available: true }>;
    return [`${h.total} ファイル${truncatedNote(h.truncated)}`, ...h.items.map((x) => `- ${x.file}  変更 ${x.commits} 回 × ${x.lines} 行 = ${x.score}（+${x.added} / -${x.deleted}）`)];
  });
  section('slowTests', () => {
    const t = report.slowTests as SlowTests;
    return [
      `テスト ${t.totalTests} 件`,
      `テストごと${truncatedNote(t.truncated.tests)}：`,
      ...t.tests.map((x) => `- ${x.seconds.toFixed(3)} 秒  ${x.file ?? '(不明)'}  ${x.name}`),
      `ファイルごと${truncatedNote(t.truncated.files)}：`,
      ...t.files.map((x) => `- ${x.seconds.toFixed(3)} 秒  ${x.file}（${x.tests} 件）`),
    ];
  });
  section('flakyTests', () => {
    const f = report.flakyTests as FlakyTestsSection;
    return [
      `失敗の後に成功した実行 ${f.runs} 件、テスト ${f.total} 件${truncatedNote(f.truncated)}${f.unreadableLogs ? `、ログが読めなかったジョブ ${f.unreadableLogs} 件` : ''}`,
      ...f.items.map((x) => `- ${x.count} 回  ${x.name}  ${x.runs.join(' ')}`),
    ];
  });
  section('mutants', () => {
    const m = report.mutants as MutantsSection;
    return [
      `mutation のジョブ ${m.runs} 件（ログが読めなかった ${m.unreadableRuns} 件${m.unreadableReason ? `。理由の例：${m.unreadableReason}` : ''}）、生き残り ${m.total} 箇所${truncatedNote(m.truncated)}。行番号はその実行の PR のもので、今の main とずれることがあります`,
      ...m.items.map((x) => `- ${x.file}:${x.line}  ${x.operator}${x.pr ? `  PR #${x.pr}` : ''}  ${x.runUrl}`),
    ];
  });

  if (report.notes.length) out.push('', '## メモ', ...report.notes.map((n) => `- ${n}`));
  if (report.diff) {
    out.push('', `## 前回（${report.diff.previousGeneratedAt}）との差（上位の中での比較）`);
    for (const s of OBSERVE_SECTIONS) {
      const d = report.diff.sections[s];
      if (d === null) out.push(`- ${TITLES[s]}：どちらかが読めないので比べていません`);
      else out.push(`- ${TITLES[s]}：新しく出た ${d.added.length} 件、消えた ${d.removed.length} 件`, ...d.added.map((k) => `  - + ${k}`), ...d.removed.map((k) => `  - - ${k}`));
    }
  }
  return out.join('\n');
}

/** OS の一時ディレクトリの下に observe.json を書き、パスを返す（リポジトリには書かない） */
export function writeReportFile(json: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'agent-harness-observe-')), 'observe.json');
  writeFileSync(path, json);
  return path;
}
