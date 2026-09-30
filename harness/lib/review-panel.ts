import { CLAUDE_MARK, extractBlock, renderBlock } from './blocks.ts';
import type { Parsed } from './plan.ts';
import { estimateCost, summarizeUsage, type PricingTable, type UsageSummary } from './usage.ts';
import { Checker } from './validate.ts';
import { BLOCKING_KINDS, type BlockingFinding, type BlockingKind, type HumanNotes } from './verdict.ts';

/**
 * 合体版のレビュー（公式の code-review に、このハーネスの観点⑥〜⑧を足したもの）の組み立てと記録。
 * 担当の出力・採点・`npm run check` の結果から reviewer と同じ形の JSON を作り、記録のコメント（```agent-review-panel）を書き出し・読み取る。
 * 純粋関数だけを置く（API・git・npm の呼び出しは harness/scripts/review-panel.ts）。流れと決まりは docs/review-panel.md。
 */

export const PANEL_MODES = ['off', 'shadow', 'enforce'] as const;
export type PanelMode = (typeof PANEL_MODES)[number];

/** 指摘を出す担当。lens1〜5 は公式の Agent #1〜#5（①〜⑤）、ac-scope は⑥、safety は⑦、overbuild は⑨（過剰さ。提案だけ） */
export const PANEL_SOURCES = ['lens1', 'lens2', 'lens3', 'lens4', 'lens5', 'ac-scope', 'safety', 'overbuild'] as const;
export type PanelSource = (typeof PANEL_SOURCES)[number];

/** 担当の出力のファイル名（拡張子なし） */
export const PANEL_OUTPUT_NAMES: readonly string[] = ['intake', 'lens1', 'lens2', 'lens3', 'lens4', 'lens5', 'ac-scope', 'safety'];
/** 無くても組み立てを止めない担当の出力（⑨は提案だけなので） */
export const PANEL_OPTIONAL_OUTPUT_NAMES: readonly string[] = ['overbuild'];

/** ⑨の指摘の種類。判定のブロッキングの種類（BLOCKING_KINDS）には入れず、合否を変えない */
export const PANEL_ADVISORY_KINDS = ['over-implementation', 'over-testing', 'over-engineering'] as const;
export type AdvisoryKind = (typeof PANEL_ADVISORY_KINDS)[number];
export type PanelKind = BlockingKind | AdvisoryKind;
const PANEL_KINDS: readonly PanelKind[] = [...BLOCKING_KINDS, ...PANEL_ADVISORY_KINDS];
/** ⑨の1判定の指摘の上限 */
export const OVERBUILD_MAX_FINDINGS = 5;
/** ⑨の出力が無かったときに humanNotes.concerns に残す文（「⑨が動いて指摘0件」と見分けるため） */
export const OVERBUILD_MISSING_NOTE = '⑨（過剰さ）の担当の出力がありません（記録なし）';

/** 確信度がこれ以上の指摘だけを扱う（公式の段階6は 80。採点の刻み 0/25/50/75/100 の 75 をブロッキングにするため 75。docs/review-panel.md） */
export const SCORE_THRESHOLD = 75;

const AC_SCOPE_KINDS = ['ac-unmet', 'out-of-scope'] as const satisfies readonly BlockingKind[];
const SAFETY_KINDS = ['data-destruction', 'secret-leak', 'regression'] as const satisfies readonly BlockingKind[];

export interface IntakeOutput {
  eligible: boolean;
  reason: string;
  claudeMd: string[];
  summary: string;
}

export interface PanelFinding {
  /** `<source>-<添字>`（その担当の findings の添字） */
  id: string;
  source: PanelSource;
  kind: PanelKind;
  file?: string;
  line?: number;
  detail: string;
  /** overbuild だけ：計画の方針ごと過剰（humanNotes.checkPoints にも入れる） */
  planLevel?: boolean;
  /** lens の rule（①は CLAUDE.md の引用） */
  rule?: string;
  /** ac-scope・safety だけ：前回のブロッキング指摘が直っていない */
  unfixedPrevious?: boolean;
}

export interface PanelOutputs {
  intake: IntakeOutput;
  findings: PanelFinding[];
  /** ac-scope・safety の concerns・checkPoints を順に連結したもの */
  notes: HumanNotes;
  /** ⑨（overbuild）の出力が無かった。組み立てで humanNotes.concerns に OVERBUILD_MISSING_NOTE を入れる */
  overbuildMissing: boolean;
  /** 担当の提案（Merge を止めない）を担当の順に連結したもの。`[提案・<担当>] <文>` の形で、採点せず nonBlocking に入れる */
  suggestions: string[];
}

export interface PanelScore {
  id: string;
  score: number;
  reason: string;
}

export interface CheckResult {
  headSha: string;
  exitCode: number;
  /** npm run check の出力の末尾 */
  outputTail: string;
}

/**
 * ⑧の `npm ci` が失敗したときのメッセージ。起動できなければその理由、0 以外で終われば終了コードと出力の末尾 20 行。
 * Windows では shell を通すので、npm が見つからないときは起動の失敗ではなく 0 以外の終了になり、理由は出力の末尾に入る
 */
export function npmCiFailureMessage(r: { status: number | null; error?: Error; stdout?: string | null; stderr?: string | null }): string {
  const head = 'npm ci が失敗しました（⑧の指摘にはしません。やり直すか人に返す）:';
  if (r.error) return `${head}\n起動できませんでした: ${r.error.message}`;
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-20).join('\n');
  return `${head}\n終了コード ${r.status ?? '(シグナルで終了)'}${tail ? `\n${tail}` : ''}`;
}

/** ファイル → 新しい側の変わった行 */
export type ChangedLines = Record<string, number[]>;

export type Treatment = 'blocking' | 'nonBlocking' | 'humanNotes' | 'dropped';

export interface PanelFindingResult {
  id: string;
  source: PanelSource;
  kind: PanelKind;
  score: number;
  treatment: Treatment;
  file?: string;
  line?: number;
  detail: string;
}

/** reviewer の出力と同じ形 */
export interface PanelReview {
  pass: boolean;
  blocking: BlockingFinding[];
  nonBlocking: string[];
  humanNotes: HumanNotes;
}

export interface PanelComposition {
  review: PanelReview;
  findings: PanelFindingResult[];
}

// ---- 担当の出力の検査 ----

function checkKnownKeys(c: Checker, o: Record<string, unknown>, path: string, known: string[]): void {
  for (const k of Object.keys(o)) if (!known.includes(k)) c.errors.push(`${path}.${k}: 未知のキーです`);
}

function optionalLine(c: Checker, value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const n = c.integer(value, path);
  if (Number.isInteger(value) && n < 1) c.errors.push(`${path}: 1 以上ではありません`);
  return n;
}

function parseIntake(c: Checker, raw: unknown): IntakeOutput {
  const o = c.object(raw, 'intake') ?? {};
  checkKnownKeys(c, o, 'intake', ['eligible', 'reason', 'claudeMd', 'summary']);
  return {
    eligible: c.boolean(o.eligible, 'intake.eligible'),
    reason: c.string(o.reason, 'intake.reason'),
    claudeMd: c.stringArray(o.claudeMd, 'intake.claudeMd'),
    summary: c.string(o.summary, 'intake.summary'),
  };
}

/** 担当の任意の suggestions を読み、`[提案・<担当>]` を付けて足す */
function readSuggestions(c: Checker, o: Record<string, unknown>, name: string, out: string[]): void {
  if (o.suggestions === undefined) return;
  out.push(...c.stringArray(o.suggestions, `${name}.suggestions`).map((s) => `[提案・${name}] ${s}`));
}

function parseLens(c: Checker, n: number, raw: unknown, suggestions: string[]): PanelFinding[] {
  const name = `lens${n}`;
  const o = c.object(raw, name) ?? {};
  checkKnownKeys(c, o, name, ['lens', 'findings', 'suggestions']);
  readSuggestions(c, o, name, suggestions);
  if (o.lens !== n) c.errors.push(`${name}.lens: ${n} ではありません`);
  const source = name as PanelSource;
  return c.array(o.findings, `${name}.findings`).map((item, i): PanelFinding => {
    const path = `${name}.findings[${i}]`;
    const f = c.object(item, path) ?? {};
    checkKnownKeys(c, f, path, ['file', 'line', 'detail', 'rule']);
    const finding: PanelFinding = {
      id: `${name}-${i}`,
      source,
      kind: n === 1 ? 'claude-md' : 'bug',
      file: c.string(f.file, `${path}.file`, { nonEmpty: true }),
      detail: c.string(f.detail, `${path}.detail`, { nonEmpty: true }),
    };
    const line = optionalLine(c, f.line, `${path}.line`);
    if (line !== undefined) finding.line = line;
    if (f.rule !== undefined) finding.rule = c.string(f.rule, `${path}.rule`);
    return finding;
  });
}

function parseChecker(c: Checker, name: 'ac-scope' | 'safety', raw: unknown, notes: HumanNotes, suggestions: string[]): PanelFinding[] {
  const kinds: readonly BlockingKind[] = name === 'ac-scope' ? AC_SCOPE_KINDS : SAFETY_KINDS;
  const o = c.object(raw, name) ?? {};
  checkKnownKeys(c, o, name, ['findings', 'concerns', 'checkPoints', 'suggestions']);
  readSuggestions(c, o, name, suggestions);
  notes.concerns.push(...c.stringArray(o.concerns, `${name}.concerns`));
  notes.checkPoints.push(...c.stringArray(o.checkPoints, `${name}.checkPoints`));
  return c.array(o.findings, `${name}.findings`).map((item, i): PanelFinding => {
    const path = `${name}.findings[${i}]`;
    const f = c.object(item, path) ?? {};
    checkKnownKeys(c, f, path, ['kind', 'file', 'line', 'detail', 'unfixedPrevious']);
    const finding: PanelFinding = {
      id: `${name}-${i}`,
      source: name,
      kind: c.oneOf(f.kind, kinds, `${path}.kind`),
      detail: c.string(f.detail, `${path}.detail`, { nonEmpty: true }),
      unfixedPrevious: c.boolean(f.unfixedPrevious, `${path}.unfixedPrevious`),
    };
    if (f.file !== undefined) finding.file = c.string(f.file, `${path}.file`, { nonEmpty: true });
    const line = optionalLine(c, f.line, `${path}.line`);
    if (line !== undefined) finding.line = line;
    return finding;
  });
}

function parseOverbuild(c: Checker, raw: unknown): PanelFinding[] {
  const name = 'overbuild';
  const o = c.object(raw, name) ?? {};
  checkKnownKeys(c, o, name, ['findings']);
  const items = c.array(o.findings, `${name}.findings`);
  if (items.length > OVERBUILD_MAX_FINDINGS) c.errors.push(`${name}.findings: ${OVERBUILD_MAX_FINDINGS} 件を超えています（${items.length} 件）`);
  return items.map((item, i): PanelFinding => {
    const path = `${name}.findings[${i}]`;
    const f = c.object(item, path) ?? {};
    checkKnownKeys(c, f, path, ['kind', 'file', 'line', 'detail', 'planLevel']);
    const finding: PanelFinding = {
      id: `${name}-${i}`,
      source: name,
      kind: c.oneOf(f.kind, PANEL_ADVISORY_KINDS, `${path}.kind`),
      file: c.string(f.file, `${path}.file`, { nonEmpty: true }),
      detail: c.string(f.detail, `${path}.detail`, { nonEmpty: true }),
    };
    const line = optionalLine(c, f.line, `${path}.line`);
    if (line !== undefined) finding.line = line;
    if (f.planLevel !== undefined) finding.planLevel = c.boolean(f.planLevel, `${path}.planLevel`);
    return finding;
  });
}

/** 担当の出力（名前 → JSON）を検査し、指摘に決まった ID を振る。8つの担当は必須、⑨（overbuild）は任意で、未知の名前・形の誤りは拒否する */
export function parsePanelOutputs(files: Record<string, unknown>): Parsed<PanelOutputs> {
  const c = new Checker();
  for (const k of Object.keys(files)) if (!PANEL_OUTPUT_NAMES.includes(k) && !PANEL_OPTIONAL_OUTPUT_NAMES.includes(k)) c.errors.push(`${k}: 未知の担当です`);
  for (const k of PANEL_OUTPUT_NAMES) if (!(k in files)) c.errors.push(`${k}: 担当の出力がありません`);
  if (c.errors.length > 0) return { ok: false, errors: c.errors };
  const notes: HumanNotes = { concerns: [], checkPoints: [] };
  const suggestions: string[] = [];
  const intake = parseIntake(c, files.intake);
  const findings = [
    ...[1, 2, 3, 4, 5].flatMap((n) => parseLens(c, n, files[`lens${n}`], suggestions)),
    ...parseChecker(c, 'ac-scope', files['ac-scope'], notes, suggestions),
    ...parseChecker(c, 'safety', files.safety, notes, suggestions),
    ...('overbuild' in files ? parseOverbuild(c, files.overbuild) : []),
  ];
  const overbuildMissing = !('overbuild' in files);
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value: { intake, findings, notes, suggestions, overbuildMissing } };
}

// ---- 組み立て ----

function parseScores(raw: unknown[], findings: PanelFinding[]): Parsed<Map<string, PanelScore>> {
  const c = new Checker();
  const ids = new Set(findings.map((f) => f.id));
  const byId = new Map<string, PanelScore>();
  raw.forEach((item, i) => {
    const path = `scores[${i}]`;
    const o = c.object(item, path);
    if (!o) return;
    checkKnownKeys(c, o, path, ['id', 'score', 'reason']);
    const id = c.string(o.id, `${path}.id`, { nonEmpty: true });
    const score = c.integer(o.score, `${path}.score`);
    if (Number.isInteger(o.score) && (score < 0 || score > 100)) c.errors.push(`${path}.score: 0〜100 の外です（${score}）`);
    const reason = c.string(o.reason, `${path}.reason`);
    if (!ids.has(id)) c.errors.push(`${path}.id: 指摘に無い ID の採点です（${id}）`);
    else if (byId.has(id)) c.errors.push(`${path}.id: 同じ ID の採点が2つあります（${id}）`);
    else byId.set(id, { id, score, reason });
  });
  for (const f of findings) if (!byId.has(f.id)) c.errors.push(`${f.id}: 採点がありません`);
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value: byId };
}

const location = (f: { file?: string; line?: number }): string => (f.file ? (f.line !== undefined ? `${f.file}:${f.line}` : f.file) : '');
const describe = (f: { file?: string; line?: number; detail: string }): string => [location(f), f.detail].filter((s) => s !== '').join(' ');

function hitsChanged(f: PanelFinding, changed: ChangedLines): boolean {
  if (!f.file || !(f.file in changed)) return false;
  return f.line === undefined || changed[f.file]!.includes(f.line);
}

/**
 * 担当の指摘・採点・⑧の結果から、reviewer と同じ形の出力と指摘ごとの扱いを作る。
 * ①は claude-md、②〜⑤は bug、⑥⑦は指摘の kind で、確信度 75 以上をブロッキングにする（75 未満は①〜⑤は捨て、⑥⑦は humanNotes.concerns）。
 * ⑧は採点せず、終了コードが 0 でなければ必ずブロッキング。再レビューでは、変わった行に当たる指摘・⑥⑦の直っていない前回の指摘・⑧だけをブロッキングにする。
 * ⑨（overbuild）の指摘は点数・再レビューに関わらず nonBlocking（計画の方針ごと過剰なら humanNotes.checkPoints にも）で、合否を変えない。
 * 採点の欠け・重複・余り・範囲外は、黙って捨てずに拒否する。担当の提案（suggestions）は採点せず、nonBlocking の末尾に入れる（合否を変えない）。
 */
export function composePanel(input: {
  findings: PanelFinding[];
  notes?: HumanNotes;
  suggestions?: string[];
  /** ⑨の出力が無かった（humanNotes.concerns に OVERBUILD_MISSING_NOTE を入れる） */
  overbuildMissing?: boolean;
  scores: unknown[];
  check: CheckResult;
  previous: { headSha: string; blocking: BlockingFinding[] } | null;
  changedLines: ChangedLines | null;
}): Parsed<PanelComposition> {
  const errors: string[] = [];
  for (const f of input.findings) if (!(PANEL_SOURCES as readonly string[]).includes(f.source)) errors.push(`${f.id}: 未知の観点です（${String(f.source)}）`);
  if (!Number.isInteger(input.check.exitCode)) errors.push('check.exitCode: 整数ではありません');
  if (input.previous && !input.changedLines) errors.push('再レビューなのに前回の head からの変わった行がありません');
  const scores = parseScores(input.scores, input.findings);
  if (!scores.ok) errors.push(...scores.errors);
  if (errors.length > 0 || !scores.ok) return { ok: false, errors };

  const blocking: BlockingFinding[] = [];
  const nonBlocking: string[] = [];
  const humanNotes: HumanNotes = { concerns: [...(input.notes?.concerns ?? [])], checkPoints: [...(input.notes?.checkPoints ?? [])] };
  if (input.check.exitCode !== 0) {
    blocking.push({ kind: 'typecheck-test-failure', detail: `npm run check が終了コード ${input.check.exitCode} で失敗しました。出力の末尾:\n${input.check.outputTail}` });
  }

  const results = input.findings.map((f): PanelFindingResult => {
    const score = scores.value.get(f.id)!.score;
    const loc = { ...(f.file ? { file: f.file } : {}), ...(f.line !== undefined ? { line: f.line } : {}) };
    if (f.source === 'overbuild') {
      // ⑨は提案だけ：点数・再レビューに関わらずブロッキングにしない
      nonBlocking.push(`[${f.kind}]（確信度 ${score}）${describe(f)}`);
      if (f.planLevel === true) humanNotes.checkPoints.push(`[${f.kind}] 計画の方針ごと過剰の疑い：${describe(f)}`);
      return { id: f.id, source: f.source, kind: f.kind, score, treatment: 'nonBlocking', ...loc, detail: f.detail };
    }
    const kind = f.kind as BlockingKind;
    const lens = f.source.startsWith('lens');
    let treatment: Treatment;
    if (score < SCORE_THRESHOLD) treatment = lens ? 'dropped' : 'humanNotes';
    else if (!input.previous) treatment = 'blocking';
    else treatment = hitsChanged(f, input.changedLines!) || (!lens && f.unfixedPrevious === true) ? 'blocking' : 'nonBlocking';

    if (treatment === 'blocking') blocking.push({ kind, ...(f.file ? { file: f.file } : {}), detail: describe(f) });
    if (treatment === 'nonBlocking') {
      nonBlocking.push(`[${f.kind}] ${describe(f)}`);
      if (!lens) humanNotes.concerns.push(`[${f.kind}] 前回の head から変わっていない行への指摘：${describe(f)}`);
    }
    if (treatment === 'humanNotes') humanNotes.concerns.push(`[${f.kind}]（確信度 ${score}）${describe(f)}`);
    return { id: f.id, source: f.source, kind, score, treatment, ...loc, detail: f.detail };
  });

  nonBlocking.push(...(input.suggestions ?? []));
  if (input.overbuildMissing === true) humanNotes.concerns.push(OVERBUILD_MISSING_NOTE);
  return { ok: true, value: { review: { pass: blocking.length === 0, blocking, nonBlocking, humanNotes }, findings: results } };
}

/** `git diff -U0` の出力から、ファイルごとの新しい側の行を読む（行の無い削除だけのハンク・削除されたファイルもキーには入る） */
export function parseChangedLines(diffU0: string): ChangedLines {
  const out: ChangedLines = {};
  let oldPath: string | null = null;
  let current: string | null = null;
  for (const line of diffU0.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldPath = null;
      current = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = line === '--- /dev/null' ? null : line.slice(4).replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = line === '+++ /dev/null' ? oldPath : line.slice(4).replace(/^b\//, '');
      if (current !== null) out[current] ??= [];
      continue;
    }
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m || current === null) continue;
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    const lines = out[current]!;
    for (let i = 0; i < count; i++) if (!lines.includes(start + i)) lines.push(start + i);
  }
  return out;
}

/** judge-input の「過去の PR のコメント」の節の PR の数と、コラボレーターのコメントが無い PR の数（④の材料の量） */
export function pastPrMaterial(judgeInput: string): { pastPrs: number; pastPrsWithoutComments: number } {
  const lines = judgeInput.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith('=== 過去の PR のコメント'));
  if (start < 0) return { pastPrs: 0, pastPrsWithoutComments: 0 };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('=== '));
  const section = end < 0 ? rest : rest.slice(0, end);
  return {
    pastPrs: section.filter((l) => l.startsWith('--- PR #')).length,
    pastPrsWithoutComments: section.filter((l) => l.trim() === '(コラボレーターのコメントなし)').length,
  };
}

/** judge-input の「=== 前回の判定」の節から head とブロッキング指摘を読む。「(なし)」なら null、読めなければエラー */
export function previousFromJudgeInput(judgeInput: string): Parsed<{ headSha: string; blocking: BlockingFinding[] } | null> {
  const lines = judgeInput.replace(/\r\n/g, '\n').split('\n');
  // PR のコメントに同じ見出しの行があっても取り違えないよう、最後の節を読む（本物の節は PR のコメントより後に出る）
  const start = lines.lastIndexOf('=== 前回の判定');
  if (start < 0) return { ok: false, errors: ['judge-input に「=== 前回の判定」の節がありません'] };
  const rest = lines.slice(start + 1);
  if (rest[0]?.trim() === '(なし)') return { ok: true, value: null };
  const headSha = rest[0]?.match(/^headSha: ([0-9a-f]{40})$/)?.[1];
  if (!headSha || rest[1] !== 'blocking:') return { ok: false, errors: ['judge-input の「前回の判定」の head を読めません'] };
  const json: string[] = [];
  for (const l of rest.slice(2)) {
    json.push(l);
    if (l !== ']' && l !== '[]') continue;
    try {
      const blocking = JSON.parse(json.join('\n')) as unknown;
      if (Array.isArray(blocking)) return { ok: true, value: { headSha, blocking: blocking as BlockingFinding[] } };
    } catch {
      // 配列の途中の ] なら続きを読む
    }
  }
  return { ok: false, errors: ['judge-input の「前回の判定」のブロッキング指摘を読めません'] };
}

// ---- 費用 ----

export interface CostSummary {
  tokens: UsageSummary;
  totalUsd: number | null;
  perModel: Record<string, number | null>;
}

function costOf(lines: string[], pricing: PricingTable): CostSummary {
  const tokens = summarizeUsage(lines);
  return { tokens, ...estimateCost(tokens, pricing) };
}

/**
 * サブエージェントの記録（meta.json と jsonl の行）から、合体版と今の reviewer の費用を分けて数える。
 * 合体版は agentType が review-* で説明が `panel <PR> <head7> <段階>`、今の reviewer は agentType が reviewer で説明が `reviewer <PR> <head7>` のもの。該当が無ければ null
 */
export function subagentCost(
  entries: { meta: { agentType?: string; description?: string }; lines: string[] }[],
  pr: number,
  head7: string,
  pricing: PricingTable,
): { panel: CostSummary | null; reviewer: CostSummary | null } {
  const panelPrefix = `panel ${pr} ${head7} `;
  const reviewerDesc = `reviewer ${pr} ${head7}`;
  const panel = entries.filter((e) => (e.meta.agentType ?? '').startsWith('review-') && (e.meta.description ?? '').trim().startsWith(panelPrefix));
  const reviewer = entries.filter((e) => e.meta.agentType === 'reviewer' && (e.meta.description ?? '').trim() === reviewerDesc);
  return {
    panel: panel.length > 0 ? costOf(panel.flatMap((e) => e.lines), pricing) : null,
    reviewer: reviewer.length > 0 ? costOf(reviewer.flatMap((e) => e.lines), pricing) : null,
  };
}

// ---- 記録のコメント ----

export interface PanelRecord {
  version: 1;
  pr: number;
  headSha: string;
  mode: 'shadow' | 'enforce';
  review: PanelReview;
  findings: PanelFindingResult[];
  check: { exitCode: number };
  material: { pastPrs: number; pastPrsWithoutComments: number };
  cost: { panel: CostSummary | null; reviewer: CostSummary | null };
}

const usd = (c: CostSummary | null): string => (c === null ? '記録なし' : c.totalUsd === null ? '不明' : `$${c.totalUsd}`);

/**
 * 記録のコメントの本文。人が読む要約には指摘の本文を入れず、ブロックの JSON のバッククォートは ` で書く
 * （モデルの出力に ```agent-verdict などが含まれても、gate.yml の if: やほかのブロックの読み取りに当たらないように）
 */
export function renderPanelRecord(record: PanelRecord): string {
  const counts = (t: Treatment): number => record.findings.filter((f) => f.treatment === t).length;
  const block = renderBlock('agent-review-panel', record).split('\n');
  const escaped = [block[0]!, ...block.slice(1, -1).map((l) => l.replace(/`/g, '\\u0060')), block.at(-1)!].join('\n');
  return [
    CLAUDE_MARK,
    `## 合体版のレビューの記録（${record.mode}）`,
    '',
    `- 結果：${record.review.pass ? '合格' : '不合格'}（ブロッキング指摘 ${record.review.blocking.length} 件）`,
    `- 指摘の扱い：ブロッキング ${counts('blocking')}・ブロッキングでない ${counts('nonBlocking')}・人への懸念 ${counts('humanNotes')}・捨てた ${counts('dropped')}`,
    `- npm run check の終了コード：${record.check.exitCode}`,
    `- 過去の PR（④の材料）：${record.material.pastPrs} 件（コラボレーターのコメントなし ${record.material.pastPrsWithoutComments} 件）`,
    `- 推定料金：合体版 ${usd(record.cost.panel)}・今の reviewer ${usd(record.cost.reviewer)}`,
    '',
    record.mode === 'shadow' ? '判定には使っていません（記録だけ）。' : 'この結果を判定の Reviewer の出力として使いました。',
    '',
    escaped,
  ].join('\n') + '\n';
}

function parseCost(c: Checker, raw: unknown, path: string): CostSummary | null {
  if (raw === null) return null;
  const o = c.object(raw, path) ?? {};
  const tokens = c.object(o.tokens, `${path}.tokens`) ?? {};
  const perModel = c.object(o.perModel, `${path}.perModel`) ?? {};
  const totalUsd = o.totalUsd === null ? null : c.number(o.totalUsd, `${path}.totalUsd`, 0);
  return { tokens: tokens as UsageSummary, totalUsd, perModel: perModel as Record<string, number | null> };
}

/** 記録のコメントの agent-review-panel ブロックを検査して読む */
export function parsePanelRecord(body: string): Parsed<PanelRecord> {
  const b = extractBlock(body, 'agent-review-panel');
  if (!b.found) return { ok: false, errors: ['agent-review-panel ブロックがありません'] };
  if (!b.ok) return { ok: false, errors: [b.error] };
  const c = new Checker();
  const o = c.object(b.value, 'record') ?? {};
  if (o.version !== 1) c.errors.push('record.version: 1 ではありません');
  const headSha = c.string(o.headSha, 'record.headSha');
  if (!/^[0-9a-f]{40}$/.test(headSha)) c.errors.push('record.headSha: 40桁の SHA ではありません');
  const review = c.object(o.review, 'record.review') ?? {};
  const blocking = c.array(review.blocking, 'record.review.blocking').map((item, i): BlockingFinding => {
    const f = c.object(item, `record.review.blocking[${i}]`) ?? {};
    return {
      kind: c.oneOf(f.kind, BLOCKING_KINDS, `record.review.blocking[${i}].kind`),
      ...(f.file !== undefined ? { file: c.string(f.file, `record.review.blocking[${i}].file`) } : {}),
      detail: c.string(f.detail, `record.review.blocking[${i}].detail`),
    };
  });
  const notes = c.object(review.humanNotes, 'record.review.humanNotes') ?? {};
  const findings = c.array(o.findings, 'record.findings').map((item, i): PanelFindingResult => {
    const path = `record.findings[${i}]`;
    const f = c.object(item, path) ?? {};
    const r: PanelFindingResult = {
      id: c.string(f.id, `${path}.id`),
      source: c.oneOf(f.source, PANEL_SOURCES, `${path}.source`),
      kind: c.oneOf(f.kind, PANEL_KINDS, `${path}.kind`),
      score: c.number(f.score, `${path}.score`, 0, 100),
      treatment: c.oneOf(f.treatment, ['blocking', 'nonBlocking', 'humanNotes', 'dropped'] as const, `${path}.treatment`),
      detail: c.string(f.detail, `${path}.detail`),
    };
    if (f.file !== undefined) r.file = c.string(f.file, `${path}.file`);
    if (f.line !== undefined) r.line = c.integer(f.line, `${path}.line`);
    return r;
  });
  const check = c.object(o.check, 'record.check') ?? {};
  const material = c.object(o.material, 'record.material') ?? {};
  const cost = c.object(o.cost, 'record.cost') ?? {};
  const record: PanelRecord = {
    version: 1,
    pr: c.integer(o.pr, 'record.pr'),
    headSha,
    mode: c.oneOf(o.mode, ['shadow', 'enforce'] as const, 'record.mode'),
    review: {
      pass: c.boolean(review.pass, 'record.review.pass'),
      blocking,
      nonBlocking: c.stringArray(review.nonBlocking, 'record.review.nonBlocking'),
      humanNotes: { concerns: c.stringArray(notes.concerns, 'record.review.humanNotes.concerns'), checkPoints: c.stringArray(notes.checkPoints, 'record.review.humanNotes.checkPoints') },
    },
    findings,
    check: { exitCode: c.integer(check.exitCode, 'record.check.exitCode') },
    material: { pastPrs: c.integer(material.pastPrs, 'record.material.pastPrs'), pastPrsWithoutComments: c.integer(material.pastPrsWithoutComments, 'record.material.pastPrsWithoutComments') },
    cost: { panel: parseCost(c, cost.panel, 'record.cost.panel'), reviewer: parseCost(c, cost.reviewer, 'record.cost.reviewer') },
  };
  if (record.review.pass !== (blocking.length === 0)) c.errors.push('record.review.pass とブロッキング指摘の有無が合いません');
  return c.errors.length > 0 ? { ok: false, errors: c.errors } : { ok: true, value: record };
}
