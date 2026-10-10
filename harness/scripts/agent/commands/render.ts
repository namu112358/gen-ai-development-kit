import { claudeMark } from '../../../lib/blocks.ts';
import { type PullRequest } from '../../../lib/state.ts';
import { findRepoRoot, missingCompanions, repoAt } from '../../plan-companions.ts';
import { type AgentCommand, blockBody, checkFile, claimBody, currentSession, fail, parseStage, renderPlan, renderVerdict, sessionUrl, usageReport } from '../cli.ts';

/**
 * 書式の検査と本文の生成（GitHub を読み書きしないもの。footer だけは PR 本文を書き換える）。
 *
 *   node harness/scripts/agent.ts render-claim [--manual] [--release] [--stage <段階>]  着手宣言（または解除）コメントの本文
 *   node harness/scripts/agent.ts render-block <reason-code> <text>       人に返すとき（agent:blocked）のコメント本文。理由コードは必須
 *   node harness/scripts/agent.ts render-plan <issue> <file>              計画コメントを検査し {body, addLabels, removeLabels, expectedGate}。
 *                                                           見込み（expectedGate）は批評の関所を含む（critique が無ければ止まる見込み。
 *                                                           GitHub を読まないので、計画より前の段階 plan-critique の宣言は確かめない）
 *   node harness/scripts/agent.ts render-verdict <pr> <headSha> <file>    判定コメントを検査し本文を出力
 *   node harness/scripts/agent.ts render-metrics <stage> <model> <minutes> [tokens]  PR に残すメトリクスのコメント本文（トークン数と推定料金は usage と同じ記録から自動で記入。読めなければ tokens か unknown。最も新しい記録に戻ったときは本文にそう書く）
 *   node harness/scripts/agent.ts check <file>                            plan / verdict / decision ブロックの書式検査のみ（plan は一緒に変えるファイルの抜けも確かめる。抜けは終了コード 1）
 *   node harness/scripts/agent.ts footer <pr> <stage> <model> <minutes> <tokens>  PR 本文のメトリクス表に1行追記
 */

const FOOTER_START = '<!-- agent-harness:metrics -->';

/** PR 本文末尾のメトリクス表（段階・モデル・所要時間・トークン使用量）に1行追記する */
export function appendFooter(body: string, row: { stage: string; model: string; minutes: string; tokens: string; session: string }): string {
  const line = `| ${new Date().toISOString().slice(0, 16)} | ${row.stage} | ${row.model} | ${row.minutes} | ${row.tokens} | ${row.session} |`;
  if (!body.includes(FOOTER_START)) {
    return [body.trimEnd(), '', FOOTER_START, '### 実行メトリクス', '', '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン | セッション |', '| --- | --- | --- | --- | --- | --- |', line].join('\n');
  }
  return `${body.trimEnd()}\n${line}`;
}

function renderMetrics(stage: string, model: string, minutes: string, tokensArg?: string): string {
  const u = usageReport();
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const tokens = u ? [u.total.input, u.total.output, u.total.cacheWrite5m + u.total.cacheWrite1h, u.total.cacheRead].map(fmt).join(' / ') : (tokensArg ?? 'unknown');
  const usd = !u ? 'unknown' : u.estimatedUsd === null ? '不明' : `$${u.estimatedUsd.toFixed(2)}`;
  return [
    claudeMark(currentSession()),
    '| 時刻 (UTC) | 段階 | モデル | 所要時間（分） | トークン（入力/出力/キャッシュ書込/キャッシュ読込） | 推定料金（USD） | セッション |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    `| ${new Date().toISOString().slice(0, 16)} | ${stage} | ${model} | ${minutes} | ${tokens} | ${usd} | ${sessionUrl() ?? '手動'} |`,
    '',
    u && !u.bySession
      ? 'トークン数と推定料金は、今のセッションの記録が見つからないため、最も新しい記録（ほかのセッションのものかもしれない）の累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。'
      : 'トークン数と推定料金は、このセッションのここまでの累計（サブエージェントを含む）。サブスク利用ではトークン単位の請求はなく、API で動かした場合の目安。',
  ].join('\n');
}

export const commands: AgentCommand[] = [
  { name: 'render-claim', run: (args) => void console.log(claimBody(args.includes('--manual'), args.includes('--release'), parseStage(args))) },
  { name: 'render-block', run: (args) => void console.log(blockBody(args[0]!, args.slice(1).join(' '))) },
  { name: 'render-plan', run: (args) => void console.log(JSON.stringify(renderPlan(Number(args[0]), args[1]!), null, 2)) },
  { name: 'render-verdict', run: (args) => void console.log(renderVerdict(Number(args[0]), args[1]!, args[2]!)) },
  { name: 'render-metrics', run: (args) => void console.log(renderMetrics(args[0]!, args[1]!, args[2]!, args[3])) },
  {
    name: 'check',
    run: (args) => {
      const r = checkFile(args[0]!);
      if (r.errors.length) fail(r.errors);
      if (r.kind === 'plan') {
        const files = (r.value as { files: string[]; split?: unknown }).files;
        const missing = (r.value as { split?: unknown }).split ? [] : missingCompanions(files, repoAt(findRepoRoot(process.cwd())));
        if (missing.length > 0) {
          console.error('計画の files に一緒に変えるファイルが抜けています（files に足して出し直す）:');
          for (const m of missing) console.error(`- ${m.file}：${m.reason}`);
          process.exit(1);
        }
      }
      console.log(`OK (${r.kind})`);
    },
  },
  {
    name: 'footer',
    run: async (args, ctx) => {
      const gh = ctx.gh();
      const n = Number(args[0]);
      const [, stage, model, minutes, tokens] = args;
      const pr = await gh.get<PullRequest>(`/pulls/${n}`);
      await gh.request('PATCH', `/pulls/${n}`, { body: { body: appendFooter(pr.body ?? '', { stage: stage!, model: model!, minutes: minutes!, tokens: tokens!, session: sessionUrl() ?? '手動' }) } });
    },
  },
];
