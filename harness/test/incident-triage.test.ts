// Issue #498：セッションの問題の記録（incident）の振り分けを Jev に問う shadow（harness/lib/incident-triage.ts）を確かめる。
// AC1：セッションの振り分けと Jev の答え（または問わなかった・失敗した理由）が <セッション>.triage.jsonl に残る。
// AC2：Jev に送る材料は kind・what・workaround だけで、秘密に見える文字列が伏せられている。
// 集計：(セッション, id) ごとに最後の行だけを数え、一致・skipped・error の件数と組み合わせを出す。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import { appendIncident, type Incident } from '../lib/incident.ts';
import type { askJev } from '../lib/jev.ts';
import {
  INCIDENT_TRIAGE_QUESTION_SET,
  appendTriage,
  buildIncidentTriageRequest,
  listTriageSessions,
  readTriage,
  triageFile,
  triageIncident,
  triageStats,
  type IncidentTriageRecord,
} from '../lib/incident-triage.ts';

const base = loadConfig();

/** 読み込んだ設定を写し、jev.mode・jev.maxDiffChars を変える */
function cfg(o: { mode?: 'off' | 'shadow' | 'enforce'; maxDiffChars?: number } = {}): HarnessConfig {
  return { ...base, jev: { ...base.jev, ...(o.mode ? { mode: o.mode } : {}), ...(o.maxDiffChars !== undefined ? { maxDiffChars: o.maxDiffChars } : {}) } };
}

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
/** 記録の置き場所を一時ディレクトリにした env（実行環境の AGENT_HARNESS_INCIDENT_DIR に頼らない） */
function tempEnv(): Record<string, string | undefined> {
  const d = mkdtempSync(join(tmpdir(), 'incident-triage-'));
  tmpDirs.push(d);
  return { AGENT_HARNESS_INCIDENT_DIR: join(d, 'incidents') };
}

/** 偽の ask。呼ばれた要求を残し、reply を返す */
function fakeAsk(reply: Awaited<ReturnType<typeof askJev>>) {
  const asked: { state: any; questions: Record<string, any> }[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request as { state: any; questions: Record<string, any> });
    return reply;
  };
  return { asked, fn };
}

const answer = (probabilities: Record<string, number>, choice: string) =>
  ({ status: 'ok', model: 'jev-test', answers: { incident_class: { type: 'choice', choice, probabilities } } }) as const;

const INCIDENT: Incident = { id: 1, at: '2026-10-01T00:00:00.000Z', kind: 'workaround', what: 'gh が無いので REST を使った', workaround: 'curl で読んだ', source: 'session' };
const NOW = new Date('2026-10-10T00:00:00.000Z');

// 秘密に見える値。リポジトリに秘密そのものの形で書かないよう、つないで作る
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
const BEARER_VALUE = 'eyJhbGciOi' + 'JIUzI1NiJ9abc';
const TOKEN_VALUE = 's3cr3t' + 'TokenValue99';

// ---- AC1：Jev の答えとセッションの振り分けが記録に残る ----

test('triageIncident：Jev が答えると、セッションの振り分け・Jev の確率と一番の種類・一致が <セッション>.triage.jsonl に残る', async () => {
  const cases: { as: 'harness' | 'environment' | 'once'; probs: Record<string, number>; top: string; agree: boolean }[] = [
    { as: 'environment', probs: { harness: 0.1, environment: 0.8, once: 0.1 }, top: 'environment', agree: true },
    { as: 'once', probs: { harness: 0.7, environment: 0.2, once: 0.1 }, top: 'harness', agree: false },
  ];
  for (const c of cases) {
    const env = tempEnv();
    const ask = fakeAsk(answer(c.probs, c.top));
    const rec = await triageIncident(cfg({ mode: 'shadow' }), 'key', 's1', INCIDENT, c.as, env, ask.fn, NOW);
    assert.equal(ask.asked.length, 1, c.as);
    assert.equal(rec.incidentId, 1);
    assert.equal(rec.session, c.as);
    assert.equal(rec.agree, c.agree);
    assert.equal(rec.questionSet, INCIDENT_TRIAGE_QUESTION_SET);
    assert.equal(rec.at, NOW.toISOString());
    assert.ok(rec.size && rec.size.chars > 0, '材料の大きさが残る');
    assert.equal(rec.jev.status, 'ok');
    if (rec.jev.status === 'ok') {
      assert.equal(rec.jev.top, c.top);
      assert.deepEqual(rec.jev.probabilities, c.probs);
      assert.equal(rec.jev.model, 'jev-test');
    }
    assert.ok(existsSync(triageFile('s1', env)), '記録のファイルがある');
    assert.ok(triageFile('s1', env).endsWith('s1.triage.jsonl'));
    assert.deepEqual(readTriage('s1', env), [rec], '返した記録がそのまま1行残る');
  }
});

test('triageIncident：鍵が無い・jev.mode=off・材料が maxDiffChars を超えるときは Jev に問わず、skipped とセッションの振り分けが残る', async () => {
  const cases: { name: string; config: HarnessConfig; key: string | undefined }[] = [
    { name: '鍵が無い', config: cfg({ mode: 'shadow' }), key: undefined },
    { name: 'jev.mode=off', config: cfg({ mode: 'off' }), key: 'key' },
    { name: 'maxDiffChars 超え', config: cfg({ mode: 'shadow', maxDiffChars: 10 }), key: 'key' },
  ];
  for (const c of cases) {
    const env = tempEnv();
    const ask = fakeAsk(answer({ harness: 1, environment: 0, once: 0 }, 'harness'));
    const rec = await triageIncident(c.config, c.key, 's1', INCIDENT, 'once', env, ask.fn, NOW);
    assert.equal(ask.asked.length, 0, `${c.name}：ask を呼ばない`);
    assert.equal(rec.jev.status, 'skipped', c.name);
    assert.equal(rec.session, 'once', c.name);
    assert.equal(rec.agree, null, c.name);
    assert.deepEqual(readTriage('s1', env), [rec], `${c.name}：記録が残る`);
  }
});

test('triageIncident：Jev が error を返す・答えに incident_class が無いときも、error とセッションの振り分けが残る', async () => {
  const replies: Awaited<ReturnType<typeof askJev>>[] = [
    { status: 'error', detail: 'HTTP 500' },
    { status: 'ok', model: 'jev-test', answers: {} },
  ];
  for (const reply of replies) {
    const env = tempEnv();
    const rec = await triageIncident(cfg({ mode: 'shadow' }), 'key', 's1', INCIDENT, 'harness', env, fakeAsk(reply).fn, NOW);
    assert.equal(rec.jev.status, 'error', JSON.stringify(reply));
    assert.equal(rec.session, 'harness');
    assert.equal(rec.agree, null);
    assert.deepEqual(readTriage('s1', env), [rec]);
  }
});

// ---- AC2：Jev に送る材料から秘密に見える文字列が伏せられている ----

test('Jev に送る材料は kind・what・workaround だけで、秘密に見える文字列は *** に伏せられ、target は入らない', async () => {
  // 伏せる前の古い記録・hook の記録を想定し、appendIncident を通さずに作る
  const secretIncident: Incident = {
    id: 3,
    at: '2026-10-01T00:00:00.000Z',
    kind: 'deny',
    target: 'target-should-not-be-sent-77',
    what: `git push が拒まれた ${GHP} Authorization: Bearer ${BEARER_VALUE}`,
    workaround: `curl https://example.test/?token=${TOKEN_VALUE} で読んだ`,
    source: 'hook',
  };
  const env = tempEnv();
  const ask = fakeAsk(answer({ harness: 0.6, environment: 0.3, once: 0.1 }, 'harness'));
  await triageIncident(cfg({ mode: 'shadow' }), 'key', 's1', secretIncident, 'harness', env, ask.fn, NOW);
  const requests = [buildIncidentTriageRequest(base, secretIncident), ask.asked[0]];
  for (const [i, req] of requests.entries()) {
    assert.ok(req, `要求 ${i} がある`);
    assert.deepEqual(Object.keys(req.state.incident).sort(), ['kind', 'what', 'workaround'], `要求 ${i}`);
    const text = JSON.stringify(req.state);
    for (const s of [GHP, BEARER_VALUE, TOKEN_VALUE, 'target-should-not-be-sent-77']) assert.ok(!text.includes(s), `要求 ${i} に ${s.slice(0, 8)}… が残っています`);
    assert.ok(text.includes('***'), `要求 ${i} に伏せ字がある`);
  }
  // 回避策の無い記録は空文字で渡す
  const noWorkaround = buildIncidentTriageRequest(base, { ...INCIDENT, workaround: undefined });
  assert.equal(noWorkaround.state.incident.workaround, '');
});

// ---- 集計 ----

test('triageStats・listTriageSessions：(セッション, id) ごとに最後の行だけを数え、一致・skipped・error と組み合わせを出す', () => {
  const env = tempEnv();
  const ok = (incidentId: number, session: 'harness' | 'environment' | 'once', top: 'harness' | 'environment' | 'once'): IncidentTriageRecord => ({
    version: 1,
    incidentId,
    at: NOW.toISOString(),
    session,
    jev: { status: 'ok', model: 'jev-test', probabilities: { harness: 0, environment: 0, once: 0, [top]: 1 }, top },
    agree: session === top,
    questionSet: INCIDENT_TRIAGE_QUESTION_SET,
    size: { chars: 100, jaRatio: 0.1 },
  });
  const other = (incidentId: number, status: 'skipped' | 'error'): IncidentTriageRecord => ({
    version: 1,
    incidentId,
    at: NOW.toISOString(),
    session: 'harness',
    jev: { status, detail: 'x' },
    agree: null,
    questionSet: INCIDENT_TRIAGE_QUESTION_SET,
    size: null,
  });
  // s1：id 1 は error の後に一致で上書き、id 2 は不一致、id 3 は skipped
  appendTriage('s1', other(1, 'error'), env);
  appendTriage('s1', ok(1, 'environment', 'environment'), env);
  appendTriage('s1', ok(2, 'once', 'harness'), env);
  appendTriage('s1', other(3, 'skipped'), env);
  // s2：同じ id 1 でも別の記録として数える。id 2 は error
  appendTriage('s2', ok(1, 'environment', 'environment'), env);
  appendTriage('s2', other(2, 'error'), env);
  // incident の記録のファイルは拾わない
  appendIncident('s3', { kind: 'deny', what: 'rm が拒まれた' }, env);

  assert.deepEqual(listTriageSessions(env).sort(), ['s1', 's2']);
  const rows = listTriageSessions(env).flatMap((session) => readTriage(session, env).map((record) => ({ session, record })));
  const stats = triageStats(rows);
  assert.equal(stats.total, 5);
  assert.equal(stats.ok, 3);
  assert.equal(stats.agree, 2);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.error, 1);
  // 組み合わせ（セッション×Jev）。キーの区切りは問わず、セッション側→Jev 側の順で読む
  const pair = (s: string, j: string) =>
    Object.entries(stats.pairs)
      .filter(([k]) => new RegExp(`^${s}\\W+${j}$`).test(k))
      .reduce((n, [, v]) => n + v, 0);
  assert.equal(pair('environment', 'environment'), 2);
  assert.equal(pair('once', 'harness'), 1);
  assert.equal(Object.values(stats.pairs).reduce((a, b) => a + b, 0), 3, '組み合わせは ok のものだけ');
});
