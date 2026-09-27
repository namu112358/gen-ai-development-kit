import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CLAUDE_MARK, extractBlock, renderBlock } from '../lib/blocks.ts';
import { LABELS, loadConfig, reasonMark, REASON_CODES, riskLabel, type ReasonCode } from '../lib/config.ts';
import { computeQueue } from '../lib/facts.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import { evaluatePlanGate, parsePlan, type Plan } from '../lib/plan.ts';
import type { Claim } from '../lib/queue.ts';
import { latestPlanGate, type PlanGateRecord, type PullRequest } from '../lib/state.ts';
import { estimateCost, findSessionTranscripts, summarizeUsage, totalTokens } from '../lib/usage.ts';
import { parseVerdict } from '../lib/verdict.ts';

/**
 * Routine と人のセッションが使う CLI。書式は投稿前に検査する。
 *
 * ■ Routine 用（GitHub API を呼ばない。投稿・ラベル操作は Routine が GitHub の MCP ツールで行う）
 *   node harness/scripts/agent.ts render-claim [--manual] [--release]     着手宣言（または解除）コメントの本文
 *   node harness/scripts/agent.ts render-block <reason-code> <text>       人に返すとき（agent:blocked）のコメント本文。理由コードは必須
 *   node harness/scripts/agent.ts render-plan <issue> <file>              計画コメントを検査し {body, addLabels, removeLabels}
 *   node harness/scripts/agent.ts render-verdict <pr> <headSha> <file>    判定コメントを検査し本文を出力
 *   node harness/scripts/agent.ts render-metrics <stage> <model> <minutes> [tokens]  PR に残すメトリクスのコメント本文（トークン数と推定料金はセッション記録から自動で記入。読めなければ tokens か unknown）
 *   node harness/scripts/agent.ts usage [transcriptPath]                  このセッション（サブエージェントを含む）のモデル別トークン数と推定料金（JSON）
 *   node harness/scripts/agent.ts check <file>                            plan / verdict ブロックの書式検査のみ
 *   node harness/scripts/agent.ts session-url                             この実行のセッション URL
 *
 * ■ 人のセッション用（gh の認証で GitHub API を呼ぶ）
 *   node harness/scripts/agent.ts queue                     次にやること（JSON）
 *   node harness/scripts/agent.ts claim <n> [--manual]      着手宣言のコメント
 *   node harness/scripts/agent.ts release <n>               着手宣言の解除コメント
 *   node harness/scripts/agent.ts show-plan <issue>         計画ゲートを通過した計画（App の記録）
 *   node harness/scripts/agent.ts post-plan <issue> <file>  計画コメントを検査して投稿
 *   node harness/scripts/agent.ts post-verdict <pr> <file>  判定コメントを検査して投稿
 *   node harness/scripts/agent.ts wait <issue> <blockers..> 依存待ち（agent:waiting）
 *   node harness/scripts/agent.ts block <n> <reason-code> <text>  agent:blocked＋理由コード
 *   node harness/scripts/agent.ts check <file>              plan / verdict ブロックの書式検査のみ
 *   node harness/scripts/agent.ts footer <pr> <stage> <model> <minutes> <tokens>  PR 本文のメトリクス表に1行追記
 *   node harness/scripts/agent.ts session-url               この実行のセッション URL
 *
 * リポジトリは GITHUB_REPOSITORY か git remote から決める。
 */

const config = loadConfig();

function repository(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = spawnGit(['remote', 'get-url', 'origin']);
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/) ?? url.match(/\/git\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`origin から owner/repo を判別できません: ${url}`);
  return m[1]!;
}

function spawnGit(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

export function sessionUrl(): string | null {
  const id = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
  return id ? `https://claude.ai/code/${id.replace(/^cse_/, 'session_')}` : null;
}


function claimBody(manual: boolean, release = false): string {
  const url = sessionUrl();
  const base: Claim = manual || !url ? { by: 'manual', at: new Date().toISOString() } : { by: 'routine', session: url, at: new Date().toISOString() };
  const value: Claim = release ? { ...base, released: true } : base;
  const who = value.by === 'routine' ? `Routine: ${value.session}` : '手動';
  return [CLAUDE_MARK, release ? `着手を解除しました（${who}）。` : `着手しました（${who}）。`, '', renderBlock('agent-claim', value)].join('\n');
}

function blockBody(code: string, text: string): string {
  if (!(code in REASON_CODES)) fail([`理由コードは ${Object.keys(REASON_CODES).join(' / ')} のいずれか`]);
  return [CLAUDE_MARK, reasonMark(code as ReasonCode), `\`agent:blocked\` にしました（${REASON_CODES[code as ReasonCode]}）。人の対応が必要です。`, '', text].join('\n');
}

async function claim(gh: GitHub, n: number, manual: boolean): Promise<void> {
  await gh.comment(n, claimBody(manual));
}

/** 計画コメントを検査し、投稿する本文と付け外しするラベルを返す（表示用の risk:* と、必要なら plan-review） */
function renderPlan(n: number, file: string): { body: string; addLabels: string[]; removeLabels: string[]; expectedGate: { pass: boolean; reasons: string[] } } {
  const checked = checkFile(file);
  if (checked.kind !== 'plan' || checked.errors.length > 0) fail(checked.errors);
  const plan = checked.value as Plan;
  const gate = evaluatePlanGate(plan, n);
  const risks = (['low', 'medium', 'high', 'critical'] as const).map(riskLabel);
  return {
    body: readBlockFile(file),
    addLabels: [riskLabel(plan.risk), ...(gate.pass ? [] : [LABELS.planReview])],
    removeLabels: risks.filter((r) => r !== riskLabel(plan.risk)),
    expectedGate: gate,
  };
}

/** 判定コメントを検査し、投稿する本文を返す。headSha は投稿直前に確かめた PR の head */
function renderVerdict(n: number, headSha: string, file: string): string {
  const checked = checkFile(file);
  if (checked.kind !== 'verdict' || checked.errors.length > 0) fail(checked.errors);
  const v = checked.value as { pr: number; headSha: string };
  if (v.pr !== n) fail([`verdict.pr（${v.pr}）が #${n} と一致しません`]);
  if (v.headSha !== headSha) fail([`verdict.headSha が現在の head（${headSha}）と一致しません。判定し直してください`]);
  return readBlockFile(file);
}

function readBlockFile(file: string): string {
  const body = readFileSync(file, 'utf8');
  return body.includes(CLAUDE_MARK) ? body : `${CLAUDE_MARK}\n${body}`;
}

function checkFile(file: string): { kind: 'plan' | 'verdict'; errors: string[]; value?: unknown } {
  const body = readFileSync(file, 'utf8');
  for (const kind of ['plan', 'verdict'] as const) {
    const b = extractBlock(body, `agent-${kind}`);
    if (!b.found) continue;
    if (!b.ok) return { kind, errors: [b.error] };
    const parsed = kind === 'plan' ? parsePlan(b.value) : parseVerdict(b.value);
    return parsed.ok ? { kind, errors: [], value: parsed.value } : { kind, errors: parsed.errors };
  }
  throw new Error('agent-plan / agent-verdict ブロックがありません');
}

async function postPlan(gh: GitHub, n: number, file: string): Promise<void> {
  const r = renderPlan(n, file);
  for (const l of r.removeLabels) await gh.removeLabel(n, l);
  await gh.addLabels(n, r.addLabels);
  const posted = await gh.comment(n, r.body);
  console.log(JSON.stringify({ posted: posted.html_url, expectedGate: r.expectedGate }, null, 2));
}

async function postVerdict(gh: GitHub, n: number, file: string): Promise<void> {
  const pr = await gh.get<PullRequest>(`/pulls/${n}`);
  const posted = await gh.comment(n, renderVerdict(n, pr.head.sha, file));
  console.log(JSON.stringify({ posted: posted.html_url }, null, 2));
}

async function showPlan(gh: GitHub, n: number): Promise<void> {
  const comments = await gh.listComments(n);
  const gate = latestPlanGate(config, comments) as { value: PlanGateRecord & { plan?: unknown; planBodySha256?: string } } | null;
  if (!gate?.value.pass) fail([`#${n} に計画ゲートを通過した計画がありません`]);
  const planComment = comments.find((c) => c.id === gate!.value.planCommentId);
  // ゲート通過後に計画コメントが編集されていたら本文は渡さない（実装の入力は App が写した計画だけ）
  const intact = planComment !== undefined && gate!.value.planBodySha256 === createHash('sha256').update(planComment.body).digest('hex');
  console.log(JSON.stringify({
    gate: gate!.value,
    planCommentUrl: planComment?.html_url,
    planCommentBody: intact ? planComment!.body : null,
    note: intact ? undefined : '計画コメントはゲート通過後に編集されたか見つかりません。gate.plan（App の写し）だけに従ってください',
  }, null, 2));
}

const FOOTER_START = '<!-- agent-harness:metrics -->';

/** PR 本文末尾のメトリクス表（段階・モデル・所要時間・トークン使用量）に1行追記する */
export function appendFooter(body: string, row: { stage: string; model: string; minutes: string; tokens: string; session: string }): string {
  const line = `| ${new Date().toISOString().slice(0, 16)} | ${row.stage} | ${row.model} | ${row.minutes} | ${row.tokens} | ${row.session} |`;
  if (!body.includes(FOOTER_START)) {
    return [body.trimEnd(), '', FOOTER_START, '### 実行メトリクス', '', '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン | セッション |', '| --- | --- | --- | --- | --- | --- |', line].join('\n');
  }
  return `${body.trimEnd()}\n${line}`;
}

/** セッション記録の集計。記録が無ければ null（処理は止めない） */
function usageReport(explicit?: string) {
  const files = findSessionTranscripts(process.cwd(), explicit);
  const lines: string[] = [];
  for (const f of files) {
    try {
      lines.push(...readFileSync(f, 'utf8').split('\n'));
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  const summary = summarizeUsage(lines);
  if (Object.keys(summary).length === 0) return null;
  const cost = estimateCost(summary, config.pricing ?? {});
  return {
    files,
    perModel: Object.fromEntries(Object.entries(summary).map(([m, tokens]) => [m, { tokens, estimatedUsd: cost.perModel[m] ?? null }])),
    total: totalTokens(summary),
    estimatedUsd: cost.totalUsd,
    note: 'API で動かした場合の推定料金（USD）。サブスク利用ではトークン単位の請求はない',
  };
}

function renderMetrics(stage: string, model: string, minutes: string, tokensArg?: string): string {
  const u = usageReport();
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const tokens = u ? [u.total.input, u.total.output, u.total.cacheWrite5m + u.total.cacheWrite1h, u.total.cacheRead].map(fmt).join(' / ') : (tokensArg ?? 'unknown');
  const usd = !u ? 'unknown' : u.estimatedUsd === null ? '不明' : `$${u.estimatedUsd.toFixed(2)}`;
  return [
    CLAUDE_MARK,
    '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン（入力/出力/キャッシュ書込/キャッシュ読込） | 推定料金（USD） | セッション |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${new Date().toISOString().slice(0, 16)} | ${stage} | ${model} | ${minutes} | ${tokens} | ${usd} | ${sessionUrl() ?? '手動'} |`,
    '',
    'トークン数と推定料金は、このセッションのここまでの累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。',
  ].join('\n');
}

function fail(errors: string[]): never {
  console.error(['書式エラー:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(2);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'session-url') return void console.log(sessionUrl() ?? '(none)');
  if (cmd === 'render-claim') return void console.log(claimBody(args.includes('--manual'), args.includes('--release')));
  if (cmd === 'render-block') return void console.log(blockBody(args[0]!, args.slice(1).join(' ')));
  if (cmd === 'render-plan') return void console.log(JSON.stringify(renderPlan(Number(args[0]), args[1]!), null, 2));
  if (cmd === 'render-verdict') return void console.log(renderVerdict(Number(args[0]), args[1]!, args[2]!));
  if (cmd === 'render-metrics') return void console.log(renderMetrics(args[0]!, args[1]!, args[2]!, args[3]));
  if (cmd === 'usage') return void console.log(JSON.stringify(usageReport(args[0]) ?? { error: 'セッション記録が見つからないか、usage がありません' }, null, 2));
  if (cmd === 'check') {
    const r = checkFile(args[0]!);
    if (r.errors.length) fail(r.errors);
    return void console.log(`OK (${r.kind})`);
  }
  const gh = new GitHub(transportFromEnv(), repository());
  const n = Number(args[0]);
  switch (cmd) {
    case 'queue': return void console.log(JSON.stringify(await computeQueue(gh, config, sessionUrl()), null, 2));
    case 'claim': return claim(gh, n, args.includes('--manual'));
    case 'release': return void (await gh.comment(n, claimBody(true, true)));
    case 'show-plan': return showPlan(gh, n);
    case 'post-plan': return postPlan(gh, n, args[1]!);
    case 'post-verdict': return postVerdict(gh, n, args[1]!);
    case 'footer': {
      const [, stage, model, minutes, tokens] = args;
      const pr = await gh.get<PullRequest>(`/pulls/${n}`);
      await gh.request('PATCH', `/pulls/${n}`, { body: { body: appendFooter(pr.body ?? '', { stage: stage!, model: model!, minutes: minutes!, tokens: tokens!, session: sessionUrl() ?? '手動' }) } });
      return;
    }
    case 'wait': {
      await gh.addLabels(n, [LABELS.waiting]);
      await gh.comment(n, `${CLAUDE_MARK}\n未解決の blocker（${args.slice(1).map((b) => `#${b}`).join(', ')}）があるため \`agent:waiting\` にしました。blocker が閉じると App が外します。`);
      return;
    }
    case 'block': {
      const body = blockBody(args[1]!, args.slice(2).join(' '));
      await gh.addLabels(n, [LABELS.blocked]);
      await gh.comment(n, body);
      return;
    }
    default:
      console.error('usage: see header of harness/scripts/agent.ts');
      process.exit(1);
  }
}

await main();
