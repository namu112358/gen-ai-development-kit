// 定期実行が、無効なスイッチ（委任承認・bypass・auto mode）の見返しの節のために最近の Issue・閉じた PR を読まないこと（Issue #441）：
// どれも無効なら読まない、ラベルがある・前回の印にある・印が無いときは今までどおり読む、切ったばかりなら前回の印で読み続ける
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModeConfig } from '../lib/auto-mode.ts';
import { appMark } from '../lib/blocks.ts';
import { bypassMergeConfig, delegateConfig, LABELS, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import { patchId } from '../lib/patch-id.ts';
import { onSchedule } from '../gates/stale.ts';
import { DIFF, config as base, ctxFor, delegateWorldFake, pr, type DelegateWorld, type FakeGitHub } from './support/gate-fixtures.ts';
import { appRecordComment } from './support/stack-fixtures.ts';

/** Risk の Jev が本物の API を呼ばないよう、jev.mode は off にする */
const config: HarnessConfig = { ...base, jev: { ...base.jev, mode: 'off' } };

const AUTO = autoModeConfig(config).label;
const BYPASS = bypassMergeConfig(config).label;
const DELEGATE = delegateConfig(config).mergeLabel;
const H = config.staleHours;
const MARK = 'agent-harness:switch-reads';

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3600_000).toISOString();
const ev = (event: 'labeled' | 'unlabeled', name: string, at: string) => ({ event, created_at: at, actor: { login: 'me' }, label: { name } });

/** Jev は問わない想定。問われたらエラーで返す */
const noJev: typeof askJev = async () => ({ status: 'error', detail: 'このテストでは問わない' });

async function schedule(fake: FakeGitHub): Promise<void> {
  await onSchedule(ctxFor(fake, 'schedule', {}, { config, secrets: { jevApiKey: 'jev-key' }, askJev: noJev }), new Date());
}

/** 見返しの節のための読み込み（閉じた PR の一覧・最近の Issue の一覧）の回数 */
function reads(fake: FakeGitHub): { closed: number; issues: number } {
  const count = (re: RegExp) => fake.calls.filter((c) => c.method === 'GET' && re.test(c.path)).length;
  return { closed: count(/\/pulls\?state=closed/), issues: count(/\/issues\?state=all/) };
}

function dashboardBody(fake: FakeGitHub): string {
  const patch = fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/issues/1')).at(-1);
  assert.ok(patch, 'ダッシュボードを書き換えていません');
  return String(patch.body.body);
}

/** 見出し（題）から次の見出しまで */
function sectionOf(body: string, title: string): string {
  const start = body.indexOf(`### ${title}`);
  assert.ok(start >= 0, `「${title}」の節がありません\n${body}`);
  const next = body.indexOf('\n### ', start);
  return body.slice(start, next >= 0 ? next : undefined);
}

/** 本文の印に並んだスイッチ。印が無ければ null */
function marked(body: string): string[] | null {
  const m = body.match(new RegExp(`<!-- ${MARK}((?: [\\w-]+)*) -->`));
  return m ? m[1]!.split(' ').filter(Boolean) : null;
}

/** 前回の定期実行が書いた本文（印にスイッチを並べる） */
const previous = (...keys: string[]): string => `${appMark('dashboard')}\n<!-- ${[MARK, ...keys].join(' ')} -->\n`;

const closedPr = (n: number, mergedAt: string | null) =>
  pr({ number: n, node_id: `PR_${n}`, state: 'closed', title: `feat: closed ${n}`, html_url: `https://x/${n}`, merged_at: mergedAt, head: { ref: `claude/issue-${n}`, sha: String(n % 10).repeat(40), repo: { full_name: 'o/r' } } });

/** auto mode で auto-merge を付けた App の記録（kind=auto-mode-merge） */
const autoArmed = (id: number, headSha: string, since: string) =>
  appRecordComment(id, 'auto-mode-merge', 'auto mode で自動経路に乗せました。', { version: 1, headSha, patchId: patchId(DIFF), since, by: 'me', skipped: [] });

/** 閉じた PR と最近の Issue があり、読めば節に出る世界 */
function world(dashboardLabels: string[], dashboardBody?: string): DelegateWorld {
  return {
    prs: [],
    closedPrs: [closedPr(31, hoursAgo(1))],
    comments: { 31: [autoArmed(312, '1'.repeat(40), hoursAgo(5))] },
    issues: { 21: [LABELS.planOk] },
    dashboardLabels,
    ...(dashboardBody === undefined ? {} : { dashboardBody }),
  };
}

const recent = `（直近 ${H} 時間）`;

test('どのスイッチも無効（ラベル無し・前回の印が空）なら、閉じた PR も最近の Issue も読まず、見返しの節は「…が無効です」、印は空', async () => {
  const fake = delegateWorldFake(world([], previous()));
  await schedule(fake);
  assert.deepEqual(reads(fake), { closed: 0, issues: 0 });
  const body = dashboardBody(fake);
  assert.match(sectionOf(body, `委任承認で Merge された PR${recent}`), /委任承認が無効です/);
  assert.match(sectionOf(body, `bypass で Merge された PR${recent}`), /bypass モードが無効です/);
  for (const title of [`auto mode で通した計画${recent}`, `auto mode で保留にした計画${recent}`, `auto mode で Merge した PR${recent}`]) {
    assert.match(sectionOf(body, title), /auto mode が無効です/, title);
  }
  assert.deepEqual(marked(body), []);
});

test('スイッチのラベルがある・前回の印にある・印が無いときは、今までどおり読む（timeline が無くてもラベルの有無で決まる）', async () => {
  const cases: { name: string; labels: string[]; body: string; closed: number; issues: number }[] = [
    { name: '委任承認のラベル', labels: [DELEGATE], body: previous(), closed: 1, issues: 0 },
    { name: 'bypass のラベル', labels: [BYPASS], body: previous(), closed: 1, issues: 0 },
    { name: 'auto mode のラベル', labels: [AUTO], body: previous(), closed: 1, issues: 1 },
    { name: 'ラベル無し・前回の印に bypass', labels: [], body: previous('bypass'), closed: 1, issues: 0 },
    { name: '印の無い本文（初回・人が書き換えた）', labels: [], body: `${appMark('dashboard')}\n`, closed: 3, issues: 1 },
  ];
  for (const c of cases) {
    const fake = delegateWorldFake(world(c.labels, c.body));
    await schedule(fake);
    assert.deepEqual(reads(fake), { closed: c.closed, issues: c.issues }, c.name);
  }
});

test('auto mode を切ったばかりなら、前回の印で閉じた PR を読み、Merge した PR を節に出し、印に auto-mode を残す', async () => {
  const w = world([AUTO], previous());
  w.dashboardEvents = [ev('labeled', AUTO, hoursAgo(5))];
  const first = delegateWorldFake(w);
  await schedule(first);
  const firstBody = dashboardBody(first);
  assert.ok(marked(firstBody)?.includes('auto-mode'), firstBody);

  w.dashboardBody = firstBody;
  w.dashboardLabels = [];
  w.dashboardEvents.push(ev('unlabeled', AUTO, hoursAgo(0.5)));
  const second = delegateWorldFake(w);
  await schedule(second);
  assert.ok(reads(second).closed >= 1, '閉じた PR を読みません');
  const body = dashboardBody(second);
  assert.match(sectionOf(body, `auto mode で Merge した PR${recent}`), /#31\b/);
  assert.ok(marked(body)?.includes('auto-mode'), body);
});
