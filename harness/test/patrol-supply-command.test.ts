// Issue #828：agent.ts の patrol-supply（harness/scripts/agent/commands/patrol-supply.ts）を、偽の GitHub（FakeGitHub）の上で run から動かして確かめる。
// (1) auto mode でない（ダッシュボードにラベルが無い・ダッシュボードが読めない・timeline が読めない）とき、ready は GET 以外の要求を出さない。
// (2) auto mode で条件を満たすとき、ready の GET 以外の要求は POST /repos/o/r/issues/<番号>/labels の1件だけで、本文は { labels: ['agent:ready'] }。
// (3) REST の行の写し方（作者は user.login）：作者が自分でない Issue では ready は GET 以外の要求を出さない。
// (4) check はどの場合も GET 以外の要求を出さず、auto mode でなければ create が空。used は一覧のうち PR・目印なし・ほかの人・24 時間より前の Issue を数えない。
// 条件ごとの細かい場合（目印なし・上限・既に agent:ready・dailyLimit 0）は harness/test/patrol-auto-supply.test.ts（lib）が確かめるので繰り返さない。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { appLogin, loadConfig } from '../lib/config.ts';
import type { AgentCommand } from '../scripts/agent/cli.ts';
import { GitHub } from '../lib/github.ts';
import { FakeGitHub } from './support/gate-fixtures.ts';

/** commands のファイルは cli.ts を import し、cli.ts は読み込み時に harness.config.json を読むので、使うときだけ読み込む */
const loadCommand = async () => {
  const mod = await import('../scripts/agent/commands/patrol-supply.ts');
  const cmd = (mod.commands as AgentCommand[]).find((c) => c.name === 'patrol-supply');
  assert.ok(cmd, 'patrol-supply のコマンドが無い');
  return cmd;
};

const config = loadConfig();
const APP = appLogin(config);
const AUTO_LABEL = config.autoMode?.label ?? 'agent:auto-mode';
const SELF = 'me';
const DASHBOARD = 1;
const HOUR = 60 * 60 * 1000;

/** 書き込み（GET 以外）の呼び出し */
const writesOf = (fake: FakeGitHub) => fake.calls.filter((c) => c.method !== 'GET');

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const marker = (ref: string) => `<!-- agent-harness:issue-source from=patrol ref=${ref} -->`;

interface Row { number: number; body: string; user: { login: string }; created_at: string; labels: { name: string }[]; pull_request?: { url: string } }
const row = (number: number, patch: Partial<Row> = {}): Row => ({
  number, body: `${marker(`qa-1-${number}`)}\n\n本文`, user: { login: SELF }, created_at: ago(10 * 60 * 1000), labels: [], ...patch,
});

type DashboardMode = 'auto' | 'no-label' | 'dashboard-throws' | 'timeline-throws';

/**
 * 偽の世界。ダッシュボード（App が作った dashboardIssueTitle の Issue）・timeline（人が auto mode のラベルを付けた記録）・GET /user・
 * Issue の一覧（creator で、ダッシュボードの検索と自分の Issue の一覧を分ける）・GET /issues/<番号> に答える
 */
function world(opts: { dashboard: DashboardMode; recent: Row[]; issues?: Row[] }): FakeGitHub {
  const dash = { number: DASHBOARD, title: config.dashboardIssueTitle, user: { login: APP }, labels: opts.dashboard === 'no-label' ? [] : [{ name: AUTO_LABEL }] };
  const byNumber = new Map([...(opts.issues ?? []), ...opts.recent].map((r) => [r.number, r]));
  return new FakeGitHub()
    .on('GET', /^\/user$/, () => ({ login: SELF }))
    .on('GET', /^\/repos\/o\/r\/issues\?(.*)$/, (m) => {
      const q = new URLSearchParams(m[1]!);
      if (q.get('creator') === APP) {
        if (opts.dashboard === 'dashboard-throws') throw new Error('ダッシュボードが読めない');
        return [dash];
      }
      if (q.get('creator') === SELF) return opts.recent;
      throw new Error(`想定外の Issue の一覧: ${m[0]}`);
    })
    .on('GET', new RegExp(`^/repos/o/r/issues/${DASHBOARD}/timeline(\\?|$)`), () => {
      if (opts.dashboard === 'timeline-throws') throw new Error('timeline が読めない');
      return [{ event: 'labeled', label: { name: AUTO_LABEL }, actor: { login: 'human' }, created_at: ago(2 * HOUR) }];
    })
    .on('GET', /^\/repos\/o\/r\/issues\/(\d+)$/, (m) => {
      const r = byNumber.get(Number(m[1]));
      if (!r) throw new Error(`Issue #${m[1]} が無い`);
      return { ...r, state: 'open', title: 'test: x' };
    })
    .on('POST', /^\/repos\/o\/r\/issues\/\d+\/labels$/, (_m, body) => (body.labels as string[]).map((name) => ({ name })));
}

/** run を動かし、最後の console.log を JSON として返す。process.exit は投げる例外にする */
async function runSupply(t: TestContext, fake: FakeGitHub, args: string[]): Promise<any> {
  const cmd = await loadCommand();
  const logs: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => void logs.push(a.map(String).join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => void errors.push(a.map(String).join(' ')));
  t.mock.method(process, 'exit', (code?: number) => {
    throw new Error(`process.exit(${code}): ${errors.join('\n')}`);
  });
  try {
    await cmd.run(args, { counter: null, gh: () => new GitHub(fake, 'o/r') });
  } finally {
    t.mock.restoreAll();
  }
  const out = logs.at(-1);
  assert.ok(out !== undefined, `出力が無い（${args.join(' ')}）`);
  return JSON.parse(out);
}

// --- (1) auto mode でないときの ready ---

test('patrol-supply ready：auto mode でない（ラベルが無い・ダッシュボードが読めない・timeline が読めない）とき、GET 以外の要求を出さず ready は偽', async (t) => {
  const cases: { name: string; dashboard: DashboardMode }[] = [
    { name: 'ダッシュボードに auto mode のラベルが無い', dashboard: 'no-label' },
    { name: 'ダッシュボードが読めない', dashboard: 'dashboard-throws' },
    { name: 'timeline が読めない', dashboard: 'timeline-throws' },
  ];
  for (const c of cases) {
    const target = row(50);
    const fake = world({ dashboard: c.dashboard, recent: [target] });
    const out = await runSupply(t, fake, ['ready', '50']);
    assert.equal(out.issue, 50, c.name);
    assert.equal(out.ready, false, c.name);
    assert.equal(out.added, false, c.name);
    assert.ok(Array.isArray(out.reasons) && out.reasons.includes('auto-mode-off'), `${c.name}: reasons に auto-mode-off が無い: ${JSON.stringify(out.reasons)}`);
    assert.deepEqual(writesOf(fake), [], `${c.name}: 書き込みがある`);
    if (c.dashboard === 'no-label') {
      assert.ok(!fake.calls.some((x) => x.path.includes('/timeline')), 'ラベルが無ければ timeline を読まない');
    }
  }
});

// --- (2) auto mode で条件を満たすときの ready ---

test('patrol-supply ready：auto mode で条件を満たすとき、GET 以外の要求は POST /issues/<番号>/labels の1件で、本文は agent:ready だけ', async (t) => {
  const target = row(50);
  // 一覧の PR（目印つき・自分）とほかの人の目印つきの Issue は先に作られていても数えないので、上限 1 の中で #50 が1件目になる
  const earlierPr = row(48, { created_at: ago(3 * HOUR), pull_request: { url: 'p' } });
  const earlierOther = row(49, { created_at: ago(2 * HOUR), user: { login: 'someone' } });
  const fake = world({ dashboard: 'auto', recent: [target, earlierOther, earlierPr] });
  const out = await runSupply(t, fake, ['ready', '50']);
  assert.deepEqual(out, { issue: 50, ready: true, reasons: [], added: true });
  const writes = writesOf(fake);
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), ['POST /repos/o/r/issues/50/labels']);
  assert.deepEqual(writes[0]!.body, { labels: ['agent:ready'] });
});

// --- (3) 作者の写し方（user.login） ---

test('patrol-supply ready：作者（user.login）が自分でない Issue では GET 以外の要求を出さず、reasons に not-self', async (t) => {
  const target = row(50, { user: { login: 'someone' } });
  const fake = world({ dashboard: 'auto', recent: [], issues: [target] });
  const out = await runSupply(t, fake, ['ready', '50']);
  assert.equal(out.ready, false);
  assert.equal(out.added, false);
  assert.ok(out.reasons.includes('not-self'), JSON.stringify(out.reasons));
  assert.deepEqual(writesOf(fake), []);
});

// --- (4) check ---

test('patrol-supply check：GET 以外の要求を出さない。auto mode でなければ create が空、auto mode なら used は自分の目印つきの直近 24 時間の Issue だけを数える', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-supply-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'candidates.json');
  // auto mode で上限に余りがあれば create に入る候補（種類 test・Risk low・ガードレールの外・重複は new）
  writeFileSync(file, JSON.stringify({ version: 1, candidates: [{ ref: 'qa-9-1', title: 'test: 候補', risk: 'low', files: ['docs/a.md'], overlap: 'new' }] }));

  const offCases: { name: string; dashboard: DashboardMode }[] = [
    { name: 'ダッシュボードに auto mode のラベルが無い', dashboard: 'no-label' },
    { name: 'ダッシュボードが読めない', dashboard: 'dashboard-throws' },
    { name: 'timeline が読めない', dashboard: 'timeline-throws' },
  ];
  for (const c of offCases) {
    const fake = world({ dashboard: c.dashboard, recent: [] });
    const out = await runSupply(t, fake, ['check', file]);
    assert.equal(out.active, false, c.name);
    assert.deepEqual(out.create, [], c.name);
    assert.deepEqual(out.manual.map((m: { ref: string; reason: string }) => [m.ref, m.reason]), [['qa-9-1', 'auto-mode-off']], c.name);
    assert.deepEqual(writesOf(fake), [], `${c.name}: 書き込みがある`);
  }

  // auto mode で、一覧に数えないもの（PR・目印なし・ほかの人・24 時間より前）と数えるもの（自分の目印つき）が混ざる
  const recent = [
    row(60, { pull_request: { url: 'p' } }),
    row(61, { body: '目印なし' }),
    row(62, { user: { login: 'someone' } }),
    row(63, { created_at: ago(30 * HOUR) }),
    row(64),
  ];
  const fake = world({ dashboard: 'auto', recent });
  const out = await runSupply(t, fake, ['check', file]);
  assert.equal(out.active, true);
  assert.equal(out.limit, config.patrolAutoSupply?.dailyLimit ?? 1);
  assert.equal(out.used, 1, `used は #64 だけを数える: ${JSON.stringify(out)}`);
  assert.equal(out.remaining, Math.max(0, out.limit - 1));
  assert.deepEqual(writesOf(fake), [], 'auto mode でも check は書かない');
  assert.ok(fake.calls.some((x) => x.method === 'GET' && x.path.startsWith('/repos/o/r/issues?') && new URLSearchParams(x.path.split('?')[1]).get('creator') === SELF), '自分が作った Issue の一覧を読んでいない');
});
