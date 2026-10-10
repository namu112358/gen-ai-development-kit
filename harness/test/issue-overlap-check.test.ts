// Issue #631：Issue の下書きの重なりをセッションから Jev に問う shadow（harness/lib/issue-overlap-check.ts）を確かめる。
// AC1：偽の Jev で、候補ごとの答え・セッションの判断・一致が <セッション>.overlap.jsonl に残り、鍵が無い・off のときは問わずに skipped が残る。
// AC2：enforce で下限以上の Issue があるとき出力がその Issue へのコメントの案を示し、shadow ではセッションの判断のまま示す。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig, type HarnessConfig } from '../lib/config.ts';
import type { askJev } from '../lib/jev.ts';
import type { OpenIssue, OverlapDraft } from '../lib/issue-overlap.ts';
import { checkIssueOverlap, overlapLogFile, readOverlapLog, renderOverlapResult } from '../lib/issue-overlap-check.ts';

const base = loadConfig();

/** 読み込んだ設定を写し、jev.mode・jev.issueOverlap を変え、下限を 0.9 にする */
function cfg(o: { mode?: 'off' | 'shadow' | 'enforce'; issueOverlap?: 'off' | 'shadow' | 'enforce' } = {}): HarnessConfig {
  return {
    ...base,
    jev: {
      ...base.jev,
      mode: o.mode ?? 'shadow',
      issueOverlap: o.issueOverlap ?? 'shadow',
      thresholds: { ...base.jev.thresholds, issueOverlapProbability: 0.9 },
    },
  };
}

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});
/** 記録の置き場所を一時ディレクトリにした env（実行環境の AGENT_HARNESS_INCIDENT_DIR に頼らない） */
function tempEnv(): Record<string, string | undefined> {
  const d = mkdtempSync(join(tmpdir(), 'issue-overlap-check-'));
  tmpDirs.push(d);
  return { AGENT_HARNESS_INCIDENT_DIR: join(d, 'incidents') };
}

/** 偽の ask。呼ばれた回数を数え、reply を返す（ネットワークを使わない） */
function fakeAsk(reply: Awaited<ReturnType<typeof askJev>>) {
  const asked: unknown[] = [];
  const fn: typeof askJev = async (_key, request) => {
    asked.push(request);
    return reply;
  };
  return { asked, fn };
}

/** 候補 #10 が 0.95・#11 が 0.1 の答え（overlapProbabilities が読む same_<番号> の noul） */
const REPLY = {
  status: 'ok',
  model: 'jev-test',
  answers: { same_10: { type: 'noul', noul: 0.95 }, same_11: { type: 'noul', noul: 0.1 } },
} as unknown as Awaited<ReturnType<typeof askJev>>;

const DRAFT: OverlapDraft = { title: 'feat(harness): Issue の重なりを Jev に問う', body: '## Goal\n\n下書きの重なりを Jev に問う。\n' };
const ISSUES: OpenIssue[] = [
  { number: 10, title: 'feat(harness): Issue の重なりを Jev に問うコマンド', body: '## Goal\n\n重なりを問う。\n', labels: [], isPullRequest: false },
  { number: 11, title: 'fix(harness): Jev の重なりの記録', body: '## Goal\n\n記録を直す。\n', labels: [], isPullRequest: false },
  { number: 12, title: 'docs: 誤字を直す', body: null, labels: [], isPullRequest: false },
];
const NOW = new Date('2026-10-11T00:00:00.000Z');

// ---- AC1：候補ごとの答え・セッションの判断・一致が記録に残る ----

test('checkIssueOverlap：鍵ありの shadow で Jev が答えると、候補ごとの確率・セッションの判断・一致が <セッション>.overlap.jsonl に1行残る', async () => {
  const cases: { session: number | null; agree: boolean }[] = [
    { session: 10, agree: true },
    { session: null, agree: false },
  ];
  for (const c of cases) {
    const env = tempEnv();
    const ask = fakeAsk(REPLY);
    const r = await checkIssueOverlap(cfg(), 'key', 's1', DRAFT, ISSUES, c.session, env, ask.fn, NOW);
    const name = `session=${c.session}`;
    assert.equal(ask.asked.length, 1, `${name}：ask を1回呼ぶ`);
    assert.equal(r.line.status, 'ok', name);
    assert.ok(r.line.record, name);
    const probs = Object.fromEntries(r.line.record!.pairs.map((p) => [p.issue, p.probability]));
    assert.equal(probs[10], 0.95, name);
    assert.equal(probs[11], 0.1, name);
    assert.equal(r.line.record!.sessionDuplicateOf, c.session, name);
    assert.equal(r.line.record!.agree, c.agree, name);
    assert.ok(overlapLogFile('s1', env).endsWith('s1.overlap.jsonl'), name);
    assert.ok(existsSync(overlapLogFile('s1', env)), `${name}：記録のファイルがある`);
    assert.deepEqual(readOverlapLog('s1', env), [r.line], `${name}：返した行がそのまま1行残る`);
  }
});

test('checkIssueOverlap：鍵が無い・jev.issueOverlap=off・jev.mode=off のときは Jev に問わず、skipped の行が残る', async () => {
  const cases: { name: string; config: HarnessConfig; key: string | undefined }[] = [
    { name: '鍵が無い', config: cfg(), key: undefined },
    { name: '鍵が空', config: cfg(), key: '' },
    { name: 'jev.issueOverlap=off', config: cfg({ issueOverlap: 'off' }), key: 'key' },
    { name: 'jev.mode=off', config: cfg({ mode: 'off' }), key: 'key' },
  ];
  for (const c of cases) {
    const env = tempEnv();
    const ask = fakeAsk(REPLY);
    const r = await checkIssueOverlap(c.config, c.key, 's1', DRAFT, ISSUES, 10, env, ask.fn, NOW);
    assert.equal(ask.asked.length, 0, `${c.name}：ask を呼ばない`);
    assert.equal(r.line.status, 'skipped', c.name);
    assert.equal(r.line.record, null, c.name);
    assert.deepEqual(readOverlapLog('s1', env), [r.line], `${c.name}：skipped の行が残る`);
    // 問わないときの提案はセッションの判断のまま
    assert.deepEqual(r.suggestion, { duplicateOf: 10, source: 'session' }, c.name);
  }
});

// ---- AC2：提案（enforce では Jev、shadow ではセッションの判断） ----

test('checkIssueOverlap：enforce で Jev が下限以上と答えると、セッションが none でも提案はその Issue へのコメントの案になる', async () => {
  const env = tempEnv();
  const r = await checkIssueOverlap(cfg({ issueOverlap: 'enforce' }), 'key', 's1', DRAFT, ISSUES, null, env, fakeAsk(REPLY).fn, NOW);
  assert.equal(r.mode, 'enforce');
  assert.deepEqual(r.suggestion, { duplicateOf: 10, source: 'jev' });
  assert.ok(renderOverlapResult(r).includes('#10 へのコメントの案'), renderOverlapResult(r));
});

test('checkIssueOverlap：shadow では Jev が下限以上と答えても、提案はセッションの判断（none なら新しい Issue の下書き）のまま', async () => {
  const env = tempEnv();
  const r = await checkIssueOverlap(cfg({ issueOverlap: 'shadow' }), 'key', 's1', DRAFT, ISSUES, null, env, fakeAsk(REPLY).fn, NOW);
  assert.equal(r.mode, 'shadow');
  assert.equal(r.line.status, 'ok');
  assert.deepEqual(r.suggestion, { duplicateOf: null, source: 'session' });
  const text = renderOverlapResult(r);
  assert.ok(text.includes('新しい Issue の下書き'), text);
  assert.ok(!text.includes('#10 へのコメントの案'), text);
});
