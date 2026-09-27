/**
 * 日本語の材料と英訳した材料を同じ問いで Jev（TypeSafe AI）に投げ比べる、手で実行する実験用スクリプト。ゲート（gate.yml）には組み込まない。
 *
 *   node harness/scripts/jev-language.ts prepare <owner/repo> <出力先> --prs <番号,…> --issues <番号,…>   gh で材料を集めて manifest を作る
 *   node harness/scripts/jev-language.ts check <manifest>                                                 訳の未確認・残る日本語・diff の食い違いを一覧にする
 *   node harness/scripts/jev-language.ts run <manifest> <結果の出力先> --confirm                          Jev に投げる（--confirm と JEV_API_KEY が無ければ見積もりだけ）
 *   node harness/scripts/jev-language.ts summarize <manifest> <結果>                                      集計して Markdown の表を出す
 *
 * `harness/lib/jev.ts` の `buildJevRequest`・`redact`、`harness/lib/issue-triage.ts` の `buildTriageRequest` を import するだけで、
 * 中身は変えない（どちらもガードレール harness/lib/** に入る）。集計・検査の純粋関数はネットワーク・GitHub を呼ばず単体テストの対象。
 * 素材の選び方・費用の見積もりの単価の出どころ・実行の手順は docs/security.md の「日本語の材料の実験」を参照。
 *
 * CLI 部分は `import.meta.main` の中だけで動く（mutate.ts と同じ形。テストが import しても何も動かない）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { flattenAnswers, redact, type JevAnswers } from '../lib/jev.ts';
import { buildJevRequest } from '../lib/jev.ts';
import { buildTriageRequest } from '../lib/issue-triage.ts';
import { parseIssueBody } from '../lib/issue-form.ts';
import { parseTitle } from '../lib/title.ts';
import { RISK_QUESTIONS } from '../lib/verdict.ts';
import { changedFiles, prDiff, type PullRequest } from '../lib/state.ts';

export { buildJevRequest, buildTriageRequest };

// ==========================================================================
// 集計・検査の純粋関数（単体テストの対象。harness/test/jev-language.test.ts）
// ==========================================================================

/** 1回分の答え（記録用の形）。Noul は `{ yes: 確率 }`、Choice は選択肢ごとの確率 */
export interface RunAnswers {
  [questionKey: string]: Record<string, number>;
}

export interface ItemResult {
  id: string;
  ja: { run1?: RunAnswers; run2?: RunAnswers };
  en: { run1?: RunAnswers; run2?: RunAnswers };
  /** 問いキー → 人の正解の選択肢名（Noul は 'yes'|'no'）。無ければその問いは Brier score・一致率の対象外 */
  truth?: Record<string, string>;
  questionKinds: Record<string, 'noul' | 'choice'>;
}

export interface PairedDiffStat {
  count: number;
  mean: number;
  meanAbs: number;
  jaHigher: number;
  enHigher: number;
}

function allQuestionKeys(items: ItemResult[]): string[] {
  const keys = new Set<string>();
  for (const item of items) for (const k of Object.keys(item.questionKinds)) keys.add(k);
  return [...keys];
}

/** 言語1つぶんの、問い1つの答えを2回分（run1・run2、無ければあるほうだけ）平均する */
function averageRuns(lang: ItemResult['ja'], key: string): Record<string, number> | undefined {
  const runs = [lang.run1?.[key], lang.run2?.[key]].filter((r): r is Record<string, number> => r !== undefined);
  if (runs.length === 0) return undefined;
  const choiceKeys = new Set<string>();
  for (const r of runs) for (const c of Object.keys(r)) choiceKeys.add(c);
  const out: Record<string, number> = {};
  for (const c of choiceKeys) out[c] = runs.reduce((s, r) => s + (r[c] ?? 0), 0) / runs.length;
  return out;
}

/** 選択肢ごとの確率分布どうしの総変動距離（非負。0〜1） */
function totalVariationDistance(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let sum = 0;
  for (const k of keys) sum += Math.abs((a[k] ?? 0) - (b[k] ?? 0));
  return sum / 2;
}

/**
 * 項目・問いごとに、日本語版2回の平均確率 − 英訳版2回の平均確率。
 * Noul は yes の確率、Choice は人の正解の選択肢の確率（正解が無ければ総変動距離＝非負の乖離量）。
 * 片方の言語の結果が欠けた項目は対から除き、excluded に件数を出す。
 */
export function pairedDifferences(items: ItemResult[]): { byQuestion: Record<string, PairedDiffStat>; excluded: Record<string, number> } {
  const acc: Record<string, { sum: number; sumAbs: number; count: number; jaHigher: number; enHigher: number }> = {};
  const excluded: Record<string, number> = {};
  for (const key of allQuestionKeys(items)) {
    acc[key] = { sum: 0, sumAbs: 0, count: 0, jaHigher: 0, enHigher: 0 };
    excluded[key] = 0;
  }
  for (const item of items) {
    for (const key of Object.keys(item.questionKinds)) {
      const ja = averageRuns(item.ja, key);
      const en = averageRuns(item.en, key);
      if (!ja || !en) {
        excluded[key] = (excluded[key] ?? 0) + 1;
        continue;
      }
      const kind = item.questionKinds[key];
      const truth = item.truth?.[key];
      let value: number;
      if (kind === 'noul') {
        value = (ja.yes ?? 0) - (en.yes ?? 0);
      } else if (truth !== undefined) {
        value = (ja[truth] ?? 0) - (en[truth] ?? 0);
      } else {
        value = totalVariationDistance(ja, en);
      }
      const a = acc[key]!;
      a.sum += value;
      a.sumAbs += Math.abs(value);
      a.count++;
      if (value > 0) a.jaHigher++;
      else if (value < 0) a.enHigher++;
    }
  }
  const byQuestion: Record<string, PairedDiffStat> = {};
  for (const [key, a] of Object.entries(acc)) {
    byQuestion[key] = { count: a.count, mean: a.count > 0 ? a.sum / a.count : NaN, meanAbs: a.count > 0 ? a.sumAbs / a.count : NaN, jaHigher: a.jaHigher, enHigher: a.enHigher };
  }
  return { byQuestion, excluded };
}

/** Brier score：人の正解に対して Noul は `(p-y)^2`、Choice は選択肢ごとの2乗和。正解の無い項目・問いは除く */
export function brierScore(items: ItemResult[], lang: 'ja' | 'en', run: 'run1' | 'run2'): { byQuestion: Record<string, { mean: number; count: number }>; excluded: number } {
  const acc: Record<string, { sum: number; count: number }> = {};
  let excluded = 0;
  for (const item of items) {
    const answers = item[lang][run];
    for (const key of Object.keys(item.questionKinds)) {
      const truth = item.truth?.[key];
      const a = answers?.[key];
      if (truth === undefined || a === undefined) {
        excluded++;
        continue;
      }
      const kind = item.questionKinds[key];
      const score = kind === 'noul' ? ((a.yes ?? 0) - (truth === 'yes' ? 1 : 0)) ** 2 : Object.entries(a).reduce((s, [c, p]) => s + (p - (c === truth ? 1 : 0)) ** 2, 0);
      const entry = (acc[key] ??= { sum: 0, count: 0 });
      entry.sum += score;
      entry.count++;
    }
  }
  const byQuestion: Record<string, { mean: number; count: number }> = {};
  for (const [key, v] of Object.entries(acc)) byQuestion[key] = { mean: v.sum / v.count, count: v.count };
  return { byQuestion, excluded };
}

/** 一致率：Noul は p>=0.5 と正解の一致、Choice は確率最大の選択肢と正解の一致 */
export function agreementRate(items: ItemResult[], lang: 'ja' | 'en', run: 'run1' | 'run2'): { byQuestion: Record<string, { rate: number; count: number }>; excluded: number } {
  const acc: Record<string, { correct: number; count: number }> = {};
  let excluded = 0;
  for (const item of items) {
    const answers = item[lang][run];
    for (const key of Object.keys(item.questionKinds)) {
      const truth = item.truth?.[key];
      const a = answers?.[key];
      if (truth === undefined || a === undefined) {
        excluded++;
        continue;
      }
      const kind = item.questionKinds[key];
      const predicted = kind === 'noul' ? ((a.yes ?? 0) >= 0.5 ? 'yes' : 'no') : Object.entries(a).sort((x, y) => y[1] - x[1])[0]?.[0];
      const entry = (acc[key] ??= { correct: 0, count: 0 });
      entry.count++;
      if (predicted === truth) entry.correct++;
    }
  }
  const byQuestion: Record<string, { rate: number; count: number }> = {};
  for (const [key, v] of Object.entries(acc)) byQuestion[key] = { rate: v.count > 0 ? v.correct / v.count : NaN, count: v.count };
  return { byQuestion, excluded };
}

/** 回ごとのぶれ：同じ言語の1回目と2回目の差（Noul は絶対値、Choice は総変動距離）の平均 */
export function runToRunSpread(items: ItemResult[], lang: 'ja' | 'en'): { byQuestion: Record<string, { meanAbsDiff: number; count: number }> } {
  const acc: Record<string, { sum: number; count: number }> = {};
  for (const item of items) {
    const runs = item[lang];
    for (const key of Object.keys(item.questionKinds)) {
      const r1 = runs.run1?.[key];
      const r2 = runs.run2?.[key];
      if (!r1 || !r2) continue;
      const kind = item.questionKinds[key];
      const diff = kind === 'noul' ? Math.abs((r1.yes ?? 0) - (r2.yes ?? 0)) : totalVariationDistance(r1, r2);
      const entry = (acc[key] ??= { sum: 0, count: 0 });
      entry.sum += diff;
      entry.count++;
    }
  }
  const byQuestion: Record<string, { meanAbsDiff: number; count: number }> = {};
  for (const [key, v] of Object.entries(acc)) byQuestion[key] = { meanAbsDiff: v.sum / v.count, count: v.count };
  return { byQuestion };
}

function median(nums: number[]): number {
  if (nums.length === 0) return NaN;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface ItemUsage {
  id: string;
  ja: { run1?: number; run2?: number };
  en: { run1?: number; run2?: number };
}

/** input_tokens の比：日本語版の合計 ÷ 英訳版の合計、および項目ごとの比の中央値 */
export function tokenRatio(items: ItemUsage[]): { totalRatio: number; medianItemRatio: number } {
  let jaTotal = 0;
  let enTotal = 0;
  const ratios: number[] = [];
  for (const item of items) {
    const ja = (item.ja.run1 ?? 0) + (item.ja.run2 ?? 0);
    const en = (item.en.run1 ?? 0) + (item.en.run2 ?? 0);
    jaTotal += ja;
    enTotal += en;
    if (en > 0) ratios.push(ja / en);
  }
  return { totalRatio: enTotal > 0 ? jaTotal / enTotal : NaN, medianItemRatio: median(ratios) };
}

/** 日本語版の input_tokens で k 層に、件数がなるべく均等になるように分ける（境界は k-1 個、値そのもの） */
export function stratifyByTokens(values: number[], k: number): { boundaries: number[]; sizes: number[] } {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sizes: number[] = [];
  const boundaries: number[] = [];
  let start = 0;
  for (let i = 0; i < k; i++) {
    const end = Math.round((n * (i + 1)) / k);
    sizes.push(end - start);
    if (i < k - 1) boundaries.push(sorted[end - 1]!);
    start = end;
  }
  return { boundaries, sizes };
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/** 文字列中の CJK 文字（漢字・ひらがな・カタカナ）の比率（空白を除いた文字数のうち） */
export function cjkRatio(text: string): number {
  const chars = [...text].filter((c) => !/\s/.test(c));
  if (chars.length === 0) return 0;
  const cjk = chars.filter((c) => CJK_RE.test(c));
  return cjk.length / chars.length;
}

export interface ManifestItem {
  id: string;
  translationReviewed: boolean;
  jaText: string;
  enText: string;
  jaDiff: string;
  enDiff: string;
}

/** diff の各行の先頭（`+`・`-`）だけを取り出した並び。行数が違えば長さも違う */
function diffShape(diff: string): string {
  return diff
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l[0])
    .join('');
}

/** 訳が済んでいない項目、英訳版に日本語が残る項目、diff の行数・並びが食い違う項目を一覧にする */
export function translationProblems(items: ManifestItem[], cjkThreshold: number): { id: string; reasons: string[] }[] {
  const out: { id: string; reasons: string[] }[] = [];
  for (const item of items) {
    const reasons: string[] = [];
    if (!item.translationReviewed) reasons.push('未確認（translationReviewed が false）');
    const ratio = cjkRatio(item.enText);
    if (ratio >= cjkThreshold) reasons.push(`英訳版に日本語らしき文字が残っています（CJK 比率 ${(ratio * 100).toFixed(1)}%）`);
    if (diffShape(item.jaDiff) !== diffShape(item.enDiff)) reasons.push('diff の行数・+/- の並びが日本語版と英訳版で食い違います');
    if (reasons.length > 0) out.push({ id: item.id, reasons });
  }
  return out;
}

/** 文字数からトークン数への換算（日本語・英語で分ける、目安）。単価の出どころは docs/security.md（https://docs.typesafe.ai/models） */
const CHARS_PER_TOKEN: Record<'ja' | 'en', number> = { ja: 1.5, en: 4 };
const DEFAULT_PRICE_PER_INPUT_TOKEN = 4 / 1_000_000;

export function estimateCost(input: { lang: 'ja' | 'en'; charCount: number; pricePerInputToken?: number }): { tokens: number; costUsd: number } {
  const tokens = input.charCount / CHARS_PER_TOKEN[input.lang];
  const price = input.pricePerInputToken ?? DEFAULT_PRICE_PER_INPUT_TOKEN;
  return { tokens, costUsd: tokens * price };
}

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/**
 * `harness/lib/jev.ts` の `askJev` と同じ形だが、本番は捨てる `usage`（トークン数）も返す。実験の集計（tokenRatio・estimateCost）に使う。
 */
export async function askJevWithUsage(
  apiKey: string,
  request: { model: string; state: unknown; questions: Record<string, unknown> },
  fetchImpl: typeof fetch = fetch,
): Promise<{ status: 'ok'; model: string; answers: JevAnswers; usage?: { input_tokens: number; output_tokens: number } } | { status: 'error'; detail: string }> {
  const body = JSON.stringify(request);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchImpl(JEV_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if ([408, 429, 529].includes(res.status) || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after') ?? 0) * 1000 || 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        continue;
      }
      const text = await res.text();
      if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}: ${redact(text, apiKey).slice(0, 300)}` };
      const json = JSON.parse(text) as { model: string; answers: JevAnswers; usage?: { input_tokens: number; output_tokens: number } };
      return { status: 'ok', model: json.model, answers: json.answers, usage: json.usage };
    } catch (e) {
      if (attempt === 2) return { status: 'error', detail: redact(String(e), apiKey).slice(0, 300) };
    }
  }
  return { status: 'error', detail: 'リトライ上限に達しました' };
}

export interface SummaryInput {
  brier: { ja: number; en: number };
  agreement: { ja: number; en: number };
  tokenRatio: number;
}

/** 集計結果を Markdown の表にする */
export function renderSummary(input: SummaryInput): string {
  const fmt = (n: number) => (Number.isFinite(n) ? String(n) : '-');
  return [
    '| 指標 | 日本語 | 英訳 |',
    '| --- | --- | --- |',
    `| Brier score（低いほど正解に近い） | ${fmt(input.brier.ja)} | ${fmt(input.brier.en)} |`,
    `| 一致率 | ${fmt(input.agreement.ja)} | ${fmt(input.agreement.en)} |`,
    '',
    `input_tokens の比（日本語 ÷ 英訳、合計）: ${fmt(input.tokenRatio)}`,
  ].join('\n');
}

// ==========================================================================
// prepare / check / run / summarize（CLI。import.meta.main の中だけで動く）
// ==========================================================================

interface ManifestPrItem {
  kind: 'pr';
  id: string;
  number: number;
  changedFiles: string[];
  jaFile: string;
  enFile: string;
  translationReviewed: boolean;
  /** q1_risk と Risk の7問。人が埋める（空で出す） */
  truth: Record<string, string>;
  skipped?: string;
}

interface ManifestIssueItem {
  kind: 'issue';
  id: string;
  number: number;
  jaTitle: string;
  jaTitleFile: string;
  enTitleFile: string;
  jaBodyFile: string;
  enBodyFile: string;
  translationReviewed: boolean;
  labels: string[];
  /** type・area・priority。ラベルからの下書き（人が確かめる） */
  truth: { type?: string; area?: string; priority?: string };
}

type ManifestEntry = ManifestPrItem | ManifestIssueItem;

interface Manifest {
  version: 1;
  repository: string;
  items: ManifestEntry[];
}

function writeText(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return name;
}

/** 人の決定（2026-09-27）：Issue タイトルは `type(scope):` の部分を残し、後ろの説明だけを英訳する */
function draftTitleTranslation(title: string): { jaTitle: string; enTitleDraft: string } {
  const parsed = parseTitle(title);
  if (!parsed.ok) return { jaTitle: title, enTitleDraft: title };
  const prefix = title.slice(0, title.length - parsed.subject.length);
  return { jaTitle: title, enTitleDraft: `${prefix}` }; // 説明部分は人/セッションが後ろに書く
}

/** area:* ラベルからの下書き（実在する area 名かは人が確かめる） */
function areaFromLabels(labels: string[]): string | undefined {
  return labels.find((l) => l.startsWith('area:'))?.slice('area:'.length);
}

async function prepare(repository: string, outDir: string, prNumbers: number[], issueNumbers: number[]): Promise<void> {
  const config = loadConfig();
  const gh = new GitHub(transportFromEnv(), repository);
  mkdirSync(outDir, { recursive: true });
  const items: ManifestEntry[] = [];

  for (const n of prNumbers) {
    const pr = await gh.get<PullRequest>(`/pulls/${n}`);
    const diff = await prDiff(gh, pr);
    const files = await changedFiles(gh, n);
    const id = `pr-${n}`;
    if (diff.length > config.jev.maxDiffChars) {
      items.push({ kind: 'pr', id, number: n, changedFiles: files, jaFile: '', enFile: '', translationReviewed: false, truth: {}, skipped: `diff が大きすぎます（${diff.length} 文字 > ${config.jev.maxDiffChars}）` });
      continue;
    }
    const jaFile = writeText(outDir, `${id}.ja.diff`, diff);
    const enFile = join(outDir, `${id}.en.diff`);
    if (!existsSync(enFile)) writeFileSync(enFile, '');
    const truth: Record<string, string> = { q1_risk: '' };
    for (const q of RISK_QUESTIONS) truth[q.key] = '';
    items.push({ kind: 'pr', id, number: n, changedFiles: files, jaFile, enFile: `${id}.en.diff`, translationReviewed: false, truth });
  }

  for (const n of issueNumbers) {
    const issue = await gh.get<{ title: string; body: string | null; labels: ({ name: string } | string)[] }>(`/issues/${n}`);
    const id = `issue-${n}`;
    const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
    const { jaTitle, enTitleDraft } = draftTitleTranslation(issue.title);
    const jaTitleFile = writeText(outDir, `${id}.title.ja.txt`, jaTitle);
    const enTitleFile = `${id}.title.en.txt`;
    if (!existsSync(join(outDir, enTitleFile))) writeFileSync(join(outDir, enTitleFile), enTitleDraft);
    const jaBodyFile = writeText(outDir, `${id}.body.ja.md`, issue.body ?? '');
    const enBodyFile = `${id}.body.en.md`;
    if (!existsSync(join(outDir, enBodyFile))) writeFileSync(join(outDir, enBodyFile), '');
    const priority = labels.find((l) => l.startsWith('priority:'))?.slice('priority:'.length);
    const type = labels.find((l) => l.startsWith('type:'))?.slice('type:'.length);
    items.push({
      kind: 'issue',
      id,
      number: n,
      jaTitle,
      jaTitleFile,
      enTitleFile,
      jaBodyFile,
      enBodyFile,
      translationReviewed: false,
      labels,
      truth: { type, area: areaFromLabels(labels), priority },
    });
  }

  const manifest: Manifest = { version: 1, repository, items };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`manifest を書きました: ${join(outDir, 'manifest.json')}（PR ${prNumbers.length} 件、Issue ${issueNumbers.length} 件）`);
}

function loadManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

function manifestDir(manifestPath: string): string {
  return join(manifestPath, '..');
}

function readIfExists(dir: string, file: string): string {
  const path = join(dir, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function checkCommand(manifestPath: string): void {
  const dir = manifestDir(manifestPath);
  const manifest = loadManifest(manifestPath);
  const targets: ManifestItem[] = manifest.items
    .filter((i) => !(i.kind === 'pr' && i.skipped))
    .map((i) =>
      i.kind === 'pr'
        ? { id: i.id, translationReviewed: i.translationReviewed, jaText: '', enText: '', jaDiff: readIfExists(dir, i.jaFile), enDiff: readIfExists(dir, i.enFile) }
        : {
            id: i.id,
            translationReviewed: i.translationReviewed,
            jaText: `${readIfExists(dir, i.jaTitleFile)}\n${readIfExists(dir, i.jaBodyFile)}`,
            enText: `${readIfExists(dir, i.enTitleFile)}\n${readIfExists(dir, i.enBodyFile)}`,
            jaDiff: '',
            enDiff: '',
          },
    );
  const problems = translationProblems(targets, 0.05);
  if (problems.length === 0) {
    console.log('OK（訳の問題は見つかりませんでした）');
    return;
  }
  for (const p of problems) console.log(`- ${p.id}: ${p.reasons.join(' / ')}`);
}

interface ResultLine {
  id: string;
  kind: 'pr' | 'issue';
  lang: 'ja' | 'en';
  run: 'run1' | 'run2';
  answers: RunAnswers;
  usage?: { input_tokens: number; output_tokens: number };
}

function existingResultKeys(resultsPath: string): Set<string> {
  if (!existsSync(resultsPath)) return new Set();
  const set = new Set<string>();
  for (const line of readFileSync(resultsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ResultLine;
      set.add(`${r.id}|${r.lang}|${r.run}`);
    } catch {
      // 壊れた行は無視して再開できるようにする
    }
  }
  return set;
}

type JevRequest = { model: string; state: unknown; questions: Record<string, unknown> };

/** 項目・言語ぶんの Jev への要求を組み立てる（PR は buildJevRequest、Issue は buildTriageRequest）。Issue Form の形でない本文は null */
function buildRequestFor(config: ReturnType<typeof loadConfig>, dir: string, item: ManifestEntry, lang: 'ja' | 'en'): JevRequest | null {
  if (item.kind === 'pr') {
    const diffText = readIfExists(dir, lang === 'ja' ? item.jaFile : item.enFile);
    const facts = { references: '', tests: '', fileKinds: '' };
    return buildJevRequest(config, diffText, item.changedFiles, facts);
  }
  const title = readIfExists(dir, lang === 'ja' ? item.jaTitleFile : item.enTitleFile).trim();
  const body = readIfExists(dir, lang === 'ja' ? item.jaBodyFile : item.enBodyFile);
  const parsed = parseIssueBody(body);
  if (!parsed.ok) return null;
  return buildTriageRequest(config, title, parsed.contract);
}

async function runCommand(manifestPath: string, resultsPath: string, confirm: boolean): Promise<void> {
  const config = loadConfig();
  const dir = manifestDir(manifestPath);
  const manifest = loadManifest(manifestPath);
  const targets = manifest.items.filter((i) => i.translationReviewed && !(i.kind === 'pr' && i.skipped));
  const existing = existingResultKeys(resultsPath);

  const planned: { item: ManifestEntry; lang: 'ja' | 'en'; run: 'run1' | 'run2'; request: JevRequest }[] = [];
  const estimatedChars: Record<'ja' | 'en', number> = { ja: 0, en: 0 };
  for (const item of targets) {
    for (const lang of ['ja', 'en'] as const) {
      const request = buildRequestFor(config, dir, item, lang);
      if (!request) {
        console.error(`${item.id} ${lang}: Issue Form の形で読めないため見送ります`);
        continue;
      }
      estimatedChars[lang] += JSON.stringify(request.state).length * 2; // run1・run2 の2回ぶん
      for (const run of ['run1', 'run2'] as const) {
        if (existing.has(`${item.id}|${lang}|${run}`)) continue;
        planned.push({ item, lang, run, request });
      }
    }
  }

  const apiKey = process.env.JEV_API_KEY;
  if (!confirm || !apiKey) {
    const jaCost = estimateCost({ lang: 'ja', charCount: estimatedChars.ja });
    const enCost = estimateCost({ lang: 'en', charCount: estimatedChars.en });
    console.log(`送る件数: ${planned.length}（--confirm と JEV_API_KEY が無いため送信しません。既に結果がある項目・言語・回は数えていません）`);
    console.log(`見積もりトークン数: 日本語 約${Math.round(jaCost.tokens)}、英語 約${Math.round(enCost.tokens)}`);
    console.log(`見積もり費用（目安、単価の出どころは https://docs.typesafe.ai/models。docs/security.md 参照）: 約$${(jaCost.costUsd + enCost.costUsd).toFixed(2)}`);
    return;
  }

  for (const { item, lang, run, request } of planned) {
    const res = await askJevWithUsage(apiKey, request);
    if (res.status === 'error') {
      console.error(`${item.id} ${lang} ${run}: エラー ${res.detail}`);
      continue;
    }
    const line: ResultLine = { id: item.id, kind: item.kind, lang, run, answers: flattenAnswers(res.answers), usage: res.usage };
    writeFileSync(resultsPath, `${JSON.stringify(line)}\n`, { flag: 'a' });
    console.log(`${item.id} ${lang} ${run}: 完了`);
  }
}

function loadResults(resultsPath: string): ResultLine[] {
  if (!existsSync(resultsPath)) return [];
  return readFileSync(resultsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ResultLine);
}

/** PR・Issue それぞれの問いの型（Noul か Choice か）。buildJevRequest・buildTriageRequest が組み立てる問いと対応させる */
const PR_QUESTION_KINDS: Record<string, 'noul' | 'choice'> = { q1_risk: 'choice', ...Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, 'noul' as const])) };
const ISSUE_QUESTION_KINDS: Record<string, 'noul' | 'choice'> = { type: 'choice', area: 'choice', priority: 'choice', ac_verifiable: 'noul', requirements_clear: 'noul' };

function toItemResults(manifest: Manifest, results: ResultLine[]): ItemResult[] {
  const byId = new Map<string, ItemResult>();
  for (const entry of manifest.items) {
    if (entry.kind === 'pr' && entry.skipped) continue;
    const questionKinds = entry.kind === 'pr' ? PR_QUESTION_KINDS : ISSUE_QUESTION_KINDS;
    const truth = Object.fromEntries(Object.entries(entry.truth).filter((e): e is [string, string] => Boolean(e[1])));
    byId.set(entry.id, { id: entry.id, ja: {}, en: {}, truth, questionKinds });
  }
  for (const r of results) {
    const item = byId.get(r.id);
    if (!item) continue;
    item[r.lang][r.run] = r.answers;
  }
  return [...byId.values()];
}

function toItemUsages(items: ItemResult[], results: ResultLine[]): ItemUsage[] {
  const find = (id: string, lang: 'ja' | 'en', run: 'run1' | 'run2') => results.find((r) => r.id === id && r.lang === lang && r.run === run)?.usage?.input_tokens;
  return items.map((it) => ({ id: it.id, ja: { run1: find(it.id, 'ja', 'run1'), run2: find(it.id, 'ja', 'run2') }, en: { run1: find(it.id, 'en', 'run1'), run2: find(it.id, 'en', 'run2') } }));
}

function overallMean(byQuestion: Record<string, { mean: number; count: number }> | Record<string, { rate: number; count: number }>, field: 'mean' | 'rate'): number {
  const values = Object.values(byQuestion)
    .map((v) => (v as Record<string, number>)[field])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
}

function summarizeCommand(manifestPath: string, resultsPath: string): void {
  const manifest = loadManifest(manifestPath);
  const results = loadResults(resultsPath);
  const items = toItemResults(manifest, results);

  const paired = pairedDifferences(items);
  const brierJa1 = brierScore(items, 'ja', 'run1');
  const brierEn1 = brierScore(items, 'en', 'run1');
  const agreeJa1 = agreementRate(items, 'ja', 'run1');
  const agreeEn1 = agreementRate(items, 'en', 'run1');
  const usages = toItemUsages(items, results);
  const ratio = tokenRatio(usages);

  console.log(renderSummary({ brier: { ja: overallMean(brierJa1.byQuestion, 'mean'), en: overallMean(brierEn1.byQuestion, 'mean') }, agreement: { ja: overallMean(agreeJa1.byQuestion, 'rate'), en: overallMean(agreeEn1.byQuestion, 'rate') }, tokenRatio: ratio.totalRatio }));
  console.log('');
  console.log('問いごとの対の差（日本語 − 英訳）:');
  for (const [key, stat] of Object.entries(paired.byQuestion)) {
    console.log(`  ${key}: 件数=${stat.count} 平均=${stat.mean.toFixed(4)} |差|平均=${stat.meanAbs.toFixed(4)} 日本語が上回り=${stat.jaHigher} 英訳が上回り=${stat.enHigher}（除外=${paired.excluded[key] ?? 0}）`);
  }
  console.log('');
  console.log(`input_tokens の比：合計 ${Number.isFinite(ratio.totalRatio) ? ratio.totalRatio.toFixed(3) : '-'}、項目ごとの中央値 ${Number.isFinite(ratio.medianItemRatio) ? ratio.medianItemRatio.toFixed(3) : '-'}`);
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const parseList = (v: string | undefined): number[] =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);

  if (cmd === 'prepare') {
    const [repository, outDir] = args;
    if (!repository || !outDir) {
      console.error('usage: node harness/scripts/jev-language.ts prepare <owner/repo> <出力先> --prs <番号,…> --issues <番号,…>');
      process.exit(1);
    }
    await prepare(repository, outDir, parseList(flag('prs')), parseList(flag('issues')));
  } else if (cmd === 'check') {
    const manifestPath = args[0];
    if (!manifestPath) {
      console.error('usage: node harness/scripts/jev-language.ts check <manifest>');
      process.exit(1);
    }
    checkCommand(manifestPath);
  } else if (cmd === 'run') {
    const [manifestPath, resultsPath] = args;
    if (!manifestPath || !resultsPath) {
      console.error('usage: node harness/scripts/jev-language.ts run <manifest> <結果の出力先> [--confirm]');
      process.exit(1);
    }
    await runCommand(manifestPath, resultsPath, args.includes('--confirm'));
  } else if (cmd === 'summarize') {
    const [manifestPath, resultsPath] = args;
    if (!manifestPath || !resultsPath) {
      console.error('usage: node harness/scripts/jev-language.ts summarize <manifest> <結果>');
      process.exit(1);
    }
    summarizeCommand(manifestPath, resultsPath);
  } else {
    console.error('使い方: node harness/scripts/jev-language.ts prepare|check|run|summarize ...');
    process.exit(1);
  }
}
