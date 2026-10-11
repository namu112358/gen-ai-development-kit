/**
 * auto mode の危険の問い（autoModePrJevRequest）を、4通りの材料（今の材料・＋Issue・＋ファイル全体・＋両方）で Jev に問い直し、
 * PR ごとの危険の確率を Markdown の表で標準出力に出す、手で実行する実験用スクリプト（Issue #596）。ゲート（gate.yml）には組み込まない。
 *
 *   node harness/scripts/jev-context.ts <owner/repo> --prs <番号,…> [--confirm]
 *       --confirm と JEV_API_KEY が両方あるときだけ Jev に問う。どちらかが無ければ、PR ごと・材料ごとの state の文字数（見積もり）だけを出す
 *
 * GitHub は読むだけ（GET と、mutation を含まない GraphQL の query だけ）。PR・Issue・記録・ラベルには何も書かず、結果もファイルに書かない。
 * `harness/lib/auto-mode.ts` の `autoModePrJevRequest`・`autoModeJevRecord`・`autoModeConfig` などを import するだけで、中身は変えない。
 * 本番の問いの文・criteria・model・保留の線は変えず、state の欄だけを足す。足した欄を Jev がどれだけ使うかも実験の結果のうち。
 *
 * CLI 部分は `import.meta.main` の中だけで動く（jev-language.ts と同じ形。テストが import しても何も動かない）。
 */
import { autoModeConfig, autoModeJevRecord, autoModePrJevRequest, type AutoModeJevRecord } from '../lib/auto-mode.ts';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { parseIssueBody } from '../lib/issue-form.ts';
import { askJev } from '../lib/jev.ts';
import { appRecords, changedFiles, closingIssues, type PullRequest } from '../lib/state.ts';

/** 材料3・4（足した state 全体）の JSON の文字数の上限は、jev.maxDiffChars のこの倍数（費用と Jev の入力の上限を抑える。本番の設定には足さない） */
export const CONTEXT_MAX_FACTOR = 2;

export interface PrMaterial {
  number: number;
  /** 問い直す head（受け付けの記録の verdictHeadSha。記録が無ければ pr.head.sha） */
  head: string;
  /** 本番の記録の危険の確率（記録が無い・autoMode.jev が無い・yes が無ければ null） */
  recordedYes: number | null;
  diff: string;
  changedFiles: string[];
  issue: { number: number; goal: string; acceptanceCriteria: string } | null;
  fileContents: { path: string; content: string }[];
}

export type VariantKey = 'base' | 'issue' | 'files' | 'both';
const VARIANT_KEYS: VariantKey[] = ['base', 'issue', 'files', 'both'];

type ProdRequest = Extract<ReturnType<typeof autoModePrJevRequest>, { ask: true }>['request'];
type JevRequest = { model: string; state: Record<string, unknown>; questions: ProdRequest['questions'] };
export type VariantCell = { ask: true; request: JevRequest } | { ask: false; reason: string };
export type Variants = Record<VariantKey, VariantCell>;
export type VariantResults = Record<VariantKey, { yes: number } | { reason: string }>;

/** Issue の本文から goal と AC を取る。本文が無い・Issue Form で読めなければ null */
export function issueContext(number: number, body: string | null): PrMaterial['issue'] {
  if (!body) return null;
  const parsed = parseIssueBody(body);
  if (!parsed.ok) return null;
  return { number, goal: parsed.contract.goal, acceptanceCriteria: parsed.contract.acceptanceCriteria };
}

/** 4通りの要求を作る。model・questions は本番と同じで、state の欄だけが違う */
export function contextVariants(config: HarnessConfig, m: PrMaterial): Variants {
  const prod = autoModePrJevRequest(config, m.diff, m.changedFiles);
  if (!prod.ask) {
    const reason = `skipped（diff が大きすぎる）: ${prod.record.detail ?? ''}`;
    return { base: { ask: false, reason }, issue: { ask: false, reason }, files: { ask: false, reason }, both: { ask: false, reason } };
  }
  const base = prod.request;
  const limit = config.jev.maxDiffChars * CONTEXT_MAX_FACTOR;
  const issue = m.issue ? { number: m.issue.number, goal: m.issue.goal, acceptance_criteria: m.issue.acceptanceCriteria } : null;
  const fileContents = m.fileContents.map((f) => ({ path: f.path, content: f.content }));

  const build = (withIssue: boolean, withFiles: boolean): VariantCell => {
    if (withIssue && !issue) return { ask: false, reason: 'Issue なし（Closes が無い、または Issue Form で読めない）' };
    const state: Record<string, unknown> = { ...base.state, ...(withIssue ? { issue } : {}), ...(withFiles ? { file_contents: fileContents } : {}) };
    if (withFiles) {
      const size = JSON.stringify(state).length;
      if (size > limit) return { ask: false, reason: `skipped（材料が大きすぎる）: ${size} 文字 > ${limit}` };
    }
    return { ask: true, request: { model: base.model, state, questions: base.questions } };
  };
  return { base: { ask: true, request: base }, issue: build(true, false), files: build(false, true), both: build(true, true) };
}

const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** GitHub（読むだけ）から PR 1件の材料を集める */
export async function collectMaterial(gh: GitHub, config: HarnessConfig, prNumber: number): Promise<PrMaterial> {
  const pr = await gh.get<PullRequest>(`/pulls/${prNumber}`);
  const comments = await gh.listComments(prNumber);
  const records = appRecords<{ verdictHeadSha?: string; autoMode?: { jev?: AutoModeJevRecord } }>(config, comments, 'acceptance');
  const last = records[records.length - 1]?.value;
  const jev = last?.autoMode?.jev;
  const head = jev && last?.verdictHeadSha ? last.verdictHeadSha : pr.head.sha;
  const recordedYes = jev && typeof jev.yes === 'number' && Number.isFinite(jev.yes) ? jev.yes : null;

  // Merge 済みの PR は base.ref（今の main）と比べると diff が空になるので、PR の base の SHA と比べる
  const diff = await gh.compareDiff(pr.base.sha, head);
  const files = await changedFiles(gh, prNumber);

  let issue: PrMaterial['issue'] = null;
  const closing = await closingIssues(gh, prNumber);
  if (closing.length > 0) {
    const found = await gh.get<{ body: string | null }>(`/issues/${closing[0]}`);
    issue = issueContext(closing[0]!, found.body);
  }

  const fileContents: PrMaterial['fileContents'] = [];
  for (const path of files) {
    const content = await gh.get<string | null>(`/contents/${encodePath(path)}?ref=${encodeURIComponent(head)}`, { accept: 'application/vnd.github.raw', raw: true, allow404: true });
    if (typeof content === 'string') fileContents.push({ path, content });
  }
  return { number: prNumber, head, recordedYes, diff, changedFiles: files, issue, fileContents };
}

/** 問うものだけ Jev に問い、危険の確率（danger の noul）か、問えなかった理由を返す */
export async function runVariants(apiKey: string, variants: Variants, ask: typeof askJev = askJev): Promise<VariantResults> {
  const out = {} as VariantResults;
  for (const key of VARIANT_KEYS) {
    const cell = variants[key];
    if (!cell.ask) {
      out[key] = { reason: cell.reason };
      continue;
    }
    const res = await ask(apiKey, cell.request);
    if (res.status === 'error') {
      out[key] = { reason: `error: ${res.detail}` };
      continue;
    }
    const yes = res.answers?.danger?.noul;
    out[key] = typeof yes === 'number' && Number.isFinite(yes) ? { yes } : { reason: `error: 危険の確率が読めない（${autoModeJevRecord(res).detail ?? ''}）` };
  }
  return out;
}

const pct = (p: number): string => `${(p * 100).toFixed(1)}%`;
const cellText = (s: string): string => s.replace(/\|/g, '/').replace(/\s*\n\s*/g, ' ');

/** PR ごとの表（PR・本番の記録・4通り）と注記を Markdown にする。保留の線は dangerSafe（1 - yes < dangerSafe なら保留） */
export function renderContextTable(rows: { material: PrMaterial; results: VariantResults }[], dangerSafe: number): string {
  const lines = ['| PR | 本番の記録 | 1 今の材料 | 2 Issue | 3 ファイル全体 | 4 両方 |', '| --- | --- | --- | --- | --- | --- |'];
  for (const { material: m, results } of rows) {
    const recorded = m.recordedYes === null ? '記録なし' : `${pct(m.recordedYes)}（${m.head.slice(0, 7)}）`;
    const cells = VARIANT_KEYS.map((key) => {
      const r = results[key];
      if ('yes' in r) return `${pct(r.yes)}（${1 - r.yes < dangerSafe ? '保留' : '通る'}）`;
      return cellText(r.reason);
    });
    lines.push(`| #${m.number} | ${recorded} | ${cells.join(' | ')} |`);
  }
  lines.push(
    '',
    '注記',
    '- 各セルは1回だけ問う。Jev は回ごとにぶれるので、数ポイントの差はぶれの中のことがある。',
    '- 問いの文は「diff と changed_files だけから」のまま。差が出なかったときは、材料が要らないのか、問いの文が足した欄を読ませていないのかを区別できない。',
    '- diff は pr.base.sha との3点比較で、本番（pr.base.ref）と違うことがある。本番の記録と1の確率がずれたら、この違いと Jev のぶれが原因の候補。',
  );
  return lines.join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repository = args[0];
  const i = args.indexOf('--prs');
  const prs = (i === -1 ? '' : (args[i + 1] ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (!repository || repository.startsWith('--') || prs.length === 0 || prs.some((n) => !Number.isInteger(n) || n <= 0)) {
    console.error('usage: node harness/scripts/jev-context.ts <owner/repo> --prs <番号,…> [--confirm]');
    process.exit(1);
  }
  const config = loadConfig();
  const gh = new GitHub(transportFromEnv(), repository);
  const apiKey = process.env.JEV_API_KEY;
  const confirm = args.includes('--confirm') && Boolean(apiKey);
  if (!confirm) console.log('--confirm と JEV_API_KEY が無いため Jev には問いません。state の文字数（見積もり）だけを出します。');

  const rows: { material: PrMaterial; results: VariantResults }[] = [];
  for (const n of prs) {
    const material = await collectMaterial(gh, config, n);
    const variants = contextVariants(config, material);
    if (confirm) {
      rows.push({ material, results: await runVariants(apiKey!, variants) });
    } else {
      const sizes = VARIANT_KEYS.map((k) => {
        const c = variants[k];
        return `${k}=${c.ask ? JSON.stringify(c.request.state).length : `問わない（${c.reason}）`}`;
      });
      console.log(`#${n}: ${sizes.join(' / ')}`);
    }
  }
  if (confirm) console.log(renderContextTable(rows, autoModeConfig(config).dangerSafe));
}
