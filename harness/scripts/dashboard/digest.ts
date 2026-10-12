/**
 * 前回のまとめからの動きを短くまとめる手元のコマンド（Issue #853）。前回のまとめからの Merge（App と人）・閉じた Issue と Epic と、
 * 今の人の判断待ち・人の Merge 待ち・止まっていそうな着手宣言を集め、人がすること3つまでのまとめを標準出力に出す。GitHub には書かない。
 *
 *   node harness/scripts/dashboard/digest.ts show [--no-mark]
 *
 * - 前回の時刻は git の共通ディレクトリの下の agent-harness/digest/state.json（`{ "version": 1, "lastDigestAt": "<ISO>" }`）。無い・壊れているときは24時間前。
 * - show は本文を出した後に前回の時刻を今にする（--no-mark なら書かない）。
 * - 材料はダッシュボードの部品（DashboardData.loadAll と buildGraph）と、Merge と閉じた Issue を読む GraphQL の問い合わせ1回。読み取りだけ（ReadOnlyTransport）。
 * - 組み立ては純粋関数で、CLI は import.meta.main の中だけで動く（テストが import しても動かない）。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appLogin, loadConfig, LABELS } from '../../lib/config.ts';
import { GitHub, transportFromEnv } from '../../lib/github.ts';
import { restUser } from '../../lib/graphql-prefetch.ts';
import { gitCommonDir, harnessStateDir, writeLocalJson } from '../../lib/local-state.ts';
import { resolveRepository } from '../../lib/repository.ts';
import { DashboardData, ReadOnlyTransport } from './github.ts';
import { buildGraph, type Task, type Todo } from './graph.ts';

export interface DigestState { version: 1; lastDigestAt: string }

/** 控えのファイルの中身を読む。無い（null）・JSON でない・version が 1 でない・時刻が読めないものは null */
export function readDigestState(text: string | null): DigestState | null {
  if (text === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const o = (v ?? {}) as { version?: unknown; lastDigestAt?: unknown };
  if (o.version !== 1 || typeof o.lastDigestAt !== 'string' || Number.isNaN(Date.parse(o.lastDigestAt))) return null;
  return { version: 1, lastDigestAt: o.lastDigestAt };
}

const DAY_MS = 86_400_000;

/** 前回の時刻。控えが無い・今より後（時計のずれ）なら今から24時間前 */
export function digestSince(state: DigestState | null, now: Date): Date {
  const t = state ? Date.parse(state.lastDigestAt) : Number.NaN;
  return Number.isNaN(t) || t > now.getTime() ? new Date(now.getTime() - DAY_MS) : new Date(t);
}

export interface SinceFacts {
  merged: { number: number; title: string; url: string; mergedAt: string; byApp: boolean }[];
  closed: { number: number; title: string; url: string; closedAt: string; epic: boolean }[];
  /** それぞれの検索が1回で読める件数を超えた（件数は「以上」） */
  truncated: { merged: boolean; closed: boolean };
}

const SINCE_QUERY = `query($search_merged: String!, $search_closed: String!) {
  rateLimit { cost limit remaining resetAt }
  merged: search(type: ISSUE, query: $search_merged, first: 100) {
    pageInfo { hasNextPage }
    nodes { ... on PullRequest { number title url mergedAt mergedBy { __typename login } } }
  }
  closed: search(type: ISSUE, query: $search_closed, first: 100) {
    pageInfo { hasNextPage }
    nodes { ... on Issue { number title url closedAt labels(first: 20) { nodes { name } } } }
  }
}`;

/** 前回からの Merge 済み PR と閉じた Issue を読む問い合わせ。検索は日付単位なので、前回の UTC の日付の前の日から広めに読む（時刻での絞り込みは buildDigest） */
export function buildSinceQuery(repository: string, since: Date): { query: string; variables: Record<string, unknown> } {
  const day = new Date(Date.parse(`${since.toISOString().slice(0, 10)}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  return {
    query: SINCE_QUERY,
    variables: {
      search_merged: `repo:${repository} is:pr is:merged merged:>=${day} sort:updated-desc`,
      search_closed: `repo:${repository} is:issue is:closed closed:>=${day} sort:updated-desc`,
    },
  };
}

/** buildSinceQuery の応答を材料にする。Merge した人が App（Bot は login[bot]）なら byApp、labels に epicLabel があれば epic。number・日時の無い node は数えない */
export function sinceFacts(data: unknown, app: string, epicLabel: string): SinceFacts {
  type Actor = { __typename: string; login: string } | null;
  type Search<N> = { pageInfo?: { hasNextPage?: boolean }; nodes?: (N | null)[] };
  type Merged = { number?: number; title?: string; url?: string; mergedAt?: string | null; mergedBy?: Actor };
  type Closed = { number?: number; title?: string; url?: string; closedAt?: string | null; labels?: { nodes?: ({ name?: string } | null)[] } };
  const d = (data ?? {}) as { merged?: Search<Merged>; closed?: Search<Closed> };
  const merged = (d.merged?.nodes ?? []).flatMap((n) =>
    typeof n?.number === 'number' && typeof n.mergedAt === 'string'
      ? [{ number: n.number, title: n.title ?? '', url: n.url ?? '', mergedAt: n.mergedAt, byApp: restUser(n.mergedBy)?.login === app }]
      : []);
  const closed = (d.closed?.nodes ?? []).flatMap((n) =>
    typeof n?.number === 'number' && typeof n.closedAt === 'string'
      ? [{ number: n.number, title: n.title ?? '', url: n.url ?? '', closedAt: n.closedAt, epic: (n.labels?.nodes ?? []).some((l) => l?.name === epicLabel) }]
      : []);
  return { merged, closed, truncated: { merged: d.merged?.pageInfo?.hasNextPage === true, closed: d.closed?.pageInfo?.hasNextPage === true } };
}

export type DigestGroup = 'merge' | 'review' | 'stop' | 'stale';
export interface DigestItem { group: DigestGroup; kind: 'issue' | 'pr'; number: number; url: string; title: string; reason: string }

export interface Digest {
  now: string;
  since: string;
  merged: SinceFacts['merged'];
  closed: SinceFacts['closed'];
  truncated: SinceFacts['truncated'];
  /** 人がすること（3件まで） */
  todo: DigestItem[];
  /** todo に入らなかった人がすることの件数 */
  rest: number;
  counts: Record<DigestGroup, number>;
}

export const DIGEST_TODO_LIMIT = 3;
export const DIGEST_MERGED_LIMIT = 5;

const GROUPS: DigestGroup[] = ['merge', 'review', 'stop', 'stale'];
const TODO_PREFIX: [string, DigestGroup][] = [['merge-pr-', 'merge'], ['review-issue-', 'review'], ['stop-issue-', 'stop']];

/** 手元の時刻で M/D HH:mm */
function localTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 前回より後の Merge・閉じた Issue と、人がすること（人の Merge 待ち → 計画ゲート → 止まる印 → 止まっていそうな宣言）を組む */
export function buildDigest(input: { now: Date; since: Date; facts: SinceFacts; todos: Todo[]; tasks: Task[] }): Digest {
  const sinceMs = input.since.getTime();
  const merged = input.facts.merged.filter((m) => Date.parse(m.mergedAt) >= sinceMs).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  const closed = input.facts.closed.filter((c) => Date.parse(c.closedAt) >= sinceMs).sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt));

  const items: DigestItem[] = [];
  const seen = new Set<string>();
  const push = (item: DigestItem): void => {
    const key = `${item.kind}-${item.number}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const group of GROUPS) {
    if (group === 'stale') {
      const stale = input.tasks.filter((t) => t.status === 'stale').sort((a, b) => a.number - b.number);
      for (const t of stale) {
        const stage = t.claim?.stage ? `段階 ${t.claim.stage}、` : '';
        const from = t.claim ? `${localTime(t.claim.at)} から` : '';
        push({ group, kind: t.kind, number: t.number, url: t.url, title: t.title, reason: `着手宣言が止まっていそう（${stage}${from}）` });
      }
      continue;
    }
    for (const t of input.todos) {
      if (TODO_PREFIX.find(([p]) => t.id.startsWith(p))?.[1] !== group) continue;
      push({ group, kind: t.kind, number: t.number, url: t.url, title: t.title, reason: t.reason });
    }
  }
  const counts: Record<DigestGroup, number> = { merge: 0, review: 0, stop: 0, stale: 0 };
  for (const i of items) counts[i.group] += 1;
  return {
    now: input.now.toISOString(),
    since: input.since.toISOString(),
    merged,
    closed,
    truncated: input.facts.truncated,
    todo: items.slice(0, DIGEST_TODO_LIMIT),
    rest: Math.max(0, items.length - DIGEST_TODO_LIMIT),
    counts,
  };
}

const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** Markdown の本文。1行目が結論。動きも人がすることも無ければその1行だけ */
export function renderDigest(d: Digest): string {
  const since = localTime(d.since);
  const todoTotal = d.todo.length + d.rest;
  if (d.merged.length === 0 && d.closed.length === 0 && todoTotal === 0) return `前回（${since}）から動きはなく、人がすることはありません。\n`;

  const mergedApp = d.merged.filter((m) => m.byApp).length;
  const epics = d.closed.filter((c) => c.epic);
  const count = (n: number, truncated: boolean): string => `${n} 件${truncated ? '以上' : ''}`;
  const mergePart = d.merged.length > 0 ? `Merge ${count(d.merged.length, d.truncated.merged)}（App ${mergedApp}・人 ${d.merged.length - mergedApp}）` : 'Merge なし';
  const closedPart = d.closed.length > 0 ? `閉じた Issue ${count(d.closed.length, d.truncated.closed)}（うち Epic ${epics.length}）` : '閉じた Issue なし';
  const c = d.counts;
  const todoPart = todoTotal > 0
    ? `人がすること ${todoTotal} 件（人の Merge 待ち ${c.merge}・計画ゲート ${c.review}・止まる印 ${c.stop}・止まっていそうな宣言 ${c.stale}）。`
    : '人がすることはありません。';
  const lines = [`前回（${since}）から ${mergePart}、${closedPart}。${todoPart}`];

  if (todoTotal > 0) {
    lines.push('', '### 人がすること');
    for (const t of d.todo) lines.push(`- #${t.number} ${oneLine(t.title)}：${oneLine(t.reason)} ${t.url}`);
    if (d.rest > 0) lines.push(`ほか ${d.rest} 件はダッシュボード（node harness/scripts/dashboard.ts）で見られます。`);
  }

  if (d.merged.length > 0 || d.closed.length > 0) {
    lines.push('', '### 進んだこと');
    for (const m of d.merged.slice(0, DIGEST_MERGED_LIMIT)) lines.push(`- Merge #${m.number} ${oneLine(m.title)}（${m.byApp ? 'App' : '人'}）`);
    if (d.merged.length > DIGEST_MERGED_LIMIT) lines.push(`- Merge ほか ${d.merged.length - DIGEST_MERGED_LIMIT} 件${d.truncated.merged ? '以上' : ''}`);
    for (const e of epics) lines.push(`- 閉じた Epic #${e.number} ${oneLine(e.title)}`);
    if (d.closed.length > 0) lines.push(`- 閉じた Issue ${count(d.closed.length, d.truncated.closed)}（うち Epic ${epics.length}）`);
  }
  return `${lines.join('\n')}\n`;
}

function repository(): string {
  const r = resolveRepository(process.env.GITHUB_REPOSITORY, () => spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim() ?? '');
  if (!r.ok) throw new Error(r.error);
  return r.repository;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function main(args: string[]): Promise<number> {
  if (args[0] !== 'show') {
    console.error('使い方: node harness/scripts/dashboard/digest.ts show [--no-mark]');
    return 1;
  }
  try {
    const config = loadConfig();
    const repo = repository();
    const gh = new GitHub(new ReadOnlyTransport(transportFromEnv()), repo);
    const common = gitCommonDir();
    if (common === null) throw new Error('git の共通ディレクトリが見つかりません（git のリポジトリの中で実行してください）');
    const statePath = join(harnessStateDir(common), 'digest', 'state.json');
    const now = new Date();
    const since = digestSince(readDigestState(readText(statePath)), now);
    const data = new DashboardData(gh, config);
    await data.loadAll();
    const graph = buildGraph(data.issues(), data.prs(), [], { now, humanClaimStaleHours: config.routine.humanClaimStaleHours });
    const { query, variables } = buildSinceQuery(repo, since);
    const facts = sinceFacts(await gh.graphql(query, variables), appLogin(config), LABELS.epic);
    process.stdout.write(renderDigest(buildDigest({ now, since, facts, todos: graph.todos, tasks: graph.tasks })));
    if (!args.includes('--no-mark')) writeLocalJson(statePath, { version: 1, lastDigestAt: now.toISOString() } satisfies DigestState);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
