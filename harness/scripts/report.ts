import { loadConfig } from '../lib/config.ts';
import { GitHub, transportFromEnv } from '../lib/github.ts';
import type { Acceptance } from '../lib/merge-route.ts';
import { appRecords, changedFiles, isAgentPr, type PullRequest } from '../lib/state.ts';
import { revertedPrNumbers, revertedShas } from '../gates/on-main-push.ts';

/**
 * 判定の集計（Jev の切り替え判断用）。GitHub だけから数える（独自 DB は持たない）。
 *
 *   node harness/scripts/report.ts <owner/repo> [days=30]
 *
 * 「実は不可だった」＝ Merge 後 7 日以内に revert された、または同じファイルを直す fix の PR が Merge された。
 * 比べる相手は Claude ではなく結果。書式の崩れた判定・受け付けられなかった判定も件数に出す。
 */

const config = loadConfig();
const [repository, daysArg] = process.argv.slice(2);
if (!repository) {
  console.error('usage: node harness/scripts/report.ts <owner/repo> [days]');
  process.exit(1);
}
const days = Number(daysArg ?? 30);
const gh = new GitHub(transportFromEnv(), repository);
const since = Date.now() - days * 86400_000;
const WEEK = 7 * 86400_000;

interface Row {
  pr: number;
  mergedAt: string | null;
  claudeAllows: boolean | null;
  jevAllows: boolean | null;
  jevStatus: string;
  rejected: number;
  reverted: boolean;
  fixedBy: number[];
}

const closed = (await gh.paginate<PullRequest & { closed_at: string | null }>('/pulls?state=closed&sort=updated&direction=desc', 10)).filter(
  (p) => p.closed_at && new Date(p.closed_at).getTime() >= since,
);
const merged = closed.filter((p) => p.merged_at);
const agentPrs = closed.filter((p) => isAgentPr(config, p, repository));

// revert の検知：main のコミットメッセージから
const commits = await gh.paginate<{ sha: string; commit: { message: string; committer: { date: string } } }>(`/commits?since=${new Date(since).toISOString()}`, 10);
const revertedPrs = new Set<number>();
for (const c of commits) {
  for (const n of revertedPrNumbers(c.commit.message)) revertedPrs.add(n);
  for (const sha of revertedShas(c.commit.message)) {
    const prs = await gh.get<{ number: number }[]>(`/commits/${sha}/pulls`).catch(() => []);
    for (const p of prs) revertedPrs.add(p.number);
  }
}

const filesOf = new Map<number, string[]>();
const files = async (n: number) => filesOf.get(n) ?? filesOf.set(n, await changedFiles(gh, n)).get(n)!;

const rows: Row[] = [];
for (const pr of agentPrs) {
  const comments = await gh.listComments(pr.number);
  const records = appRecords<Acceptance>(config, comments, 'acceptance');
  const last = records.at(-1)?.value ?? null;
  const rejected = comments.filter((c) => c.body.includes('kind=verdict-rejected')).length;
  const fixedBy: number[] = [];
  if (pr.merged_at) {
    const mine = new Set(await files(pr.number));
    const mergedAt = new Date(pr.merged_at).getTime();
    for (const other of merged) {
      if (other.number === pr.number || !other.merged_at) continue;
      const t = new Date(other.merged_at).getTime();
      if (t <= mergedAt || t - mergedAt > WEEK) continue;
      if (!/^(fix|hotfix)|修正/i.test(other.title) && !/(^|\/)fix/i.test(other.head.ref)) continue;
      if ((await files(other.number)).some((f) => mine.has(f))) fixedBy.push(other.number);
    }
  }
  rows.push({
    pr: pr.number,
    mergedAt: pr.merged_at ?? null,
    claudeAllows: last ? last.autoEligible : null,
    jevAllows: last?.jev?.allows ?? null,
    jevStatus: last?.jev?.status ?? '-',
    rejected,
    reverted: revertedPrs.has(pr.number),
    fixedBy,
  });
}

const bad = (r: Row) => r.reverted || r.fixedBy.length > 0;
const judged = rows.filter((r) => r.claudeAllows !== null);
const jevOk = rows.filter((r) => r.jevStatus === 'ok');
const negatives = judged.filter((r) => r.claudeAllows === false).length;
const jevOnly = jevOk.filter((r) => r.jevAllows === true && r.claudeAllows === false);
const jevMisses = jevOk.filter((r) => r.jevAllows === true && bad(r));
const claudeMisses = judged.filter((r) => r.claudeAllows === true && bad(r));

const yn = (v: boolean | null) => (v === null ? '-' : v ? '可' : '不可');
console.log(
  [
    `# 判定の集計（直近 ${days} 日、Agent PR ${rows.length} 件）`,
    '',
    '| 指標 | 値 |',
    '| --- | --- |',
    `| 判定を受け付けた PR | ${judged.length} |`,
    `| 否定側（Claude が自動 Merge 不可） | ${negatives} |`,
    `| Jev の応答あり | ${jevOk.length} |`,
    `| Claude の「可」の外れ（revert / fix） | ${claudeMisses.length} |`,
    `| Jev の「可」の外れ（revert / fix） | ${jevMisses.length} |`,
    `| Jev だけが「可」 | ${jevOnly.length} |`,
    `| 受け付けられなかった判定コメント | ${rows.reduce((a, r) => a + r.rejected, 0)} |`,
    '',
    `切り替え条件（docs/plan.md）：Jev の「可」の外れ 0、Jev だけが「可」0、否定側 20 件以上 → ${jevMisses.length === 0 && jevOnly.length === 0 && negatives >= 20 ? '**満たす**' : '満たさない'}`,
    '',
    '| PR | Merge | Claude | Jev | revert | fix PR | 却下 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| #${r.pr} | ${r.mergedAt?.slice(0, 10) ?? '-'} | ${yn(r.claudeAllows)} | ${r.jevStatus === 'ok' ? yn(r.jevAllows) : r.jevStatus} | ${r.reverted ? '○' : ''} | ${r.fixedBy.map((n) => `#${n}`).join(' ')} | ${r.rejected || ''} |`),
  ].join('\n'),
);
