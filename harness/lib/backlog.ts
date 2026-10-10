/**
 * 開いた Issue をまとめて見る backlog の skill の、決まる部分（Issue #183）。GitHub を呼ばない純粋関数だけを置く。
 * 対象の選び方・触りそうなファイルの重なり・似た Issue の組を出す。本当に重複か・先に Merge すべき側などの判断は skill がする。
 * 読み込み（GitHub）は harness/scripts/agent/commands/backlog.ts の `backlog-scan`。
 */
import { LABELS, type HarnessConfig } from './config.ts';
import { patternsOverlap } from './epic.ts';
import { type FleetTargetItem, fleetTargets } from './fleet.ts';
import { parseIssueBody } from './issue-form.ts';
import { parseTitle } from './title.ts';

/** 似た組にするしきい値（タイトル＋Goal の係数にも、Requirements の項目どうしの係数にも同じ値を使う。変えたらテストも直す） */
export const SIMILAR_THRESHOLD = 0.3;

/**
 * backlog-scan が番号なしのときの対象。fleetTargets（PR・ダッシュボード・信頼できない作成者を除く）のうち、
 * agent:ready か agent:plan-review の付いた Issue と、agent:* が無く type:* の付いた Issue だけを残し、epic を除く
 */
export function backlogTargets<T extends FleetTargetItem>(items: T[], config: HarnessConfig): T[] {
  return fleetTargets(items, config).filter((i) => {
    const names = i.labels.map((l) => l.name);
    if (names.includes('epic')) return false;
    if (names.includes(LABELS.ready) || names.includes(LABELS.planReview)) return true;
    return !names.some((n) => n.startsWith('agent:')) && names.some((n) => n.startsWith('type:'));
  });
}

export interface IssueSignal {
  number: number;
  title: string;
  labels: string[];
  /** 触りそうなファイル（計画の files があればそれ、無ければ本文のパス） */
  files: string[];
  filesFrom: 'plan' | 'body';
  /** 本文が挙げている他の Issue の番号 */
  mentions: number[];
  goal: string;
  requirements: string[];
  /** Issue Form として読めたか */
  formOk: boolean;
}

const PATH_EXT = /\.(ts|md|json|yml|html)$/;

/** 本文のバッククォートで囲んだパスらしい文字列（空白を含まず、`/` を含むか既知の拡張子で終わる。http で始まるものは除く）。重複は除く */
export function bodyPaths(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const s = m[1]!.trim();
    if (/\s/.test(s) || s.startsWith('http')) continue;
    if ((s.includes('/') || PATH_EXT.test(s)) && !out.includes(s)) out.push(s);
  }
  return out;
}

function listItems(text: string): string[] {
  return text.split('\n').map((l) => l.match(/^\s*(?:[-*]|\d+\.)\s+(?:\[[ xX]\]\s+)?(.+)$/)?.[1]?.trim()).filter((x): x is string => Boolean(x));
}

/** Issue 1件から、重なり・似た組の材料を取り出す。planFiles は計画ゲートの記録の計画の files（無ければ null） */
export function issueSignals(
  item: { number: number; title: string; body: string | null; labels: { name: string }[] },
  planFiles: string[] | null,
): IssueSignal {
  const body = item.body ?? '';
  const parsed = parseIssueBody(body);
  const t = parseTitle(item.title);
  const mentions = [...new Set([...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))].filter((n) => n !== item.number);
  return {
    number: item.number,
    title: item.title,
    labels: item.labels.map((l) => l.name),
    files: planFiles ?? bodyPaths(body),
    filesFrom: planFiles !== null ? 'plan' : 'body',
    mentions,
    goal: parsed.ok ? parsed.contract.goal : t.ok ? t.subject : item.title,
    requirements: parsed.ok ? listItems(parsed.contract.requirements) : [],
    formOk: parsed.ok,
  };
}

function ordered(signals: IssueSignal[]): [IssueSignal, IssueSignal][] {
  const sorted = [...signals].sort((a, b) => a.number - b.number);
  return sorted.flatMap((a, i) => sorted.slice(i + 1).map((b): [IssueSignal, IssueSignal] => [a, b]));
}

const mentioned = (a: IssueSignal, b: IssueSignal): boolean => a.mentions.includes(b.number) || b.mentions.includes(a.number);

export interface OverlapPair {
  /** [小さい番号, 大きい番号] */
  issues: [number, number];
  /** 重なったパスの組（[小さい番号側, 大きい番号側]） */
  paths: [string, string][];
  /** どちらかの本文が相手の番号を挙げているか（挙げていなければ Dependencies の追記の候補） */
  mentioned: boolean;
}

/** 触りそうなファイルが重なる Issue の組 */
export function fileOverlaps(signals: IssueSignal[]): OverlapPair[] {
  const out: OverlapPair[] = [];
  for (const [a, b] of ordered(signals)) {
    const paths = a.files.flatMap((x) => b.files.filter((y) => patternsOverlap(x, y)).map((y): [string, string] => [x, y]));
    if (paths.length > 0) out.push({ issues: [a.number, b.number], paths, mentioned: mentioned(a, b) });
  }
  return out;
}

function grams(s: string): Set<string> {
  const t = [...s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')];
  if (t.length === 0) return new Set();
  if (t.length === 1) return new Set(t);
  return new Set(t.slice(1).map((c, i) => t[i]! + c));
}

/** 文字の 2-gram の Jaccard 係数（大文字小文字・空白・記号は無視。どちらかが空なら 0） */
export function similarity(a: string, b: string): number {
  const x = grams(a);
  const y = grams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}

export interface SimilarPair {
  issues: [number, number];
  /** タイトル（type(scope): を除く）と Goal を合わせた文字の係数 */
  score: number;
  /** Requirements の項目どうしの係数の最大 */
  requirementScore: number;
  mentioned: boolean;
}

function headline(s: IssueSignal): string {
  const t = parseTitle(s.title);
  return `${t.ok ? t.subject : s.title} ${s.goal}`;
}

/** タイトル＋Goal か Requirements の項目のどちらかが SIMILAR_THRESHOLD 以上の組 */
export function similarPairs(signals: IssueSignal[]): SimilarPair[] {
  const out: SimilarPair[] = [];
  for (const [a, b] of ordered(signals)) {
    const score = similarity(headline(a), headline(b));
    const requirementScore = Math.max(0, ...a.requirements.flatMap((x) => b.requirements.map((y) => similarity(x, y))));
    if (score >= SIMILAR_THRESHOLD || requirementScore >= SIMILAR_THRESHOLD) {
      out.push({ issues: [a.number, b.number], score, requirementScore, mentioned: mentioned(a, b) });
    }
  }
  return out;
}

export interface BacklogTarget {
  number: number;
  title: string;
  priorities: string[];
  filesFrom: 'plan' | 'body';
  fileCount: number;
  formOk: boolean;
}

export interface BacklogScan {
  targets: BacklogTarget[];
  overlaps: OverlapPair[];
  similar: SimilarPair[];
}

export function backlogScan(signals: IssueSignal[]): BacklogScan {
  return {
    targets: signals.map((s) => ({
      number: s.number,
      title: s.title,
      priorities: s.labels.filter((l) => l.startsWith('priority:')),
      filesFrom: s.filesFrom,
      fileCount: s.files.length,
      formOk: s.formOk,
    })),
    overlaps: fileOverlaps(signals),
    similar: similarPairs(signals),
  };
}

const num = (n: number): string => n.toFixed(2);

/** backlogScan の結果のテキストの表（対象・触りそうなファイルの重なり・似た Issue の組の3つの節） */
export function renderBacklogScan(scan: BacklogScan): string {
  const lines: string[] = [`## 対象（${scan.targets.length} 件）`];
  if (scan.targets.length === 0) lines.push('なし');
  for (const t of scan.targets) {
    lines.push(`- #${t.number} ${t.title}｜priority: ${t.priorities.join(', ') || 'なし'}｜ファイル ${t.fileCount} 件（出どころ ${t.filesFrom}）${t.formOk ? '' : '｜Form として読めない'}`);
  }
  lines.push('', `## 触りそうなファイルの重なり（${scan.overlaps.length} 組）`);
  if (scan.overlaps.length === 0) lines.push('なし');
  for (const o of scan.overlaps) {
    const paths = o.paths.map(([a, b]) => (a === b ? a : `${a} ~ ${b}`)).join(', ');
    lines.push(`- #${o.issues[0]} と #${o.issues[1]}｜${paths}｜${o.mentioned ? '相手の番号を挙げている' : '相手の番号を挙げていない'}`);
  }
  lines.push('', `## 似た Issue の組（${scan.similar.length} 組）`);
  if (scan.similar.length === 0) lines.push('なし');
  for (const s of scan.similar) {
    lines.push(`- #${s.issues[0]} と #${s.issues[1]}｜タイトル・Goal ${num(s.score)}｜Requirements ${num(s.requirementScore)}｜${s.mentioned ? '相手の番号を挙げている' : '相手の番号を挙げていない'}`);
  }
  return lines.join('\n');
}
