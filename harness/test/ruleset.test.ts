// Ruleset のプロジェクト側の必須チェックを harness.config.json の projectChecks で決める（Issue #154）
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHECKS, GITHUB_ACTIONS_APP_ID, loadConfig, projectChecks, type HarnessConfig } from '../lib/config.ts';
import { RULESET_NAME, rulesetBody, rulesetSummary } from '../lib/ruleset.ts';

const APP_ID = 424242;
const base = loadConfig();
/** projectChecks を書いていない設定 */
const unset: HarnessConfig = (() => {
  const c: Partial<HarnessConfig> = { ...base };
  delete c.projectChecks;
  return c as HarnessConfig;
})();
/** 検査を確かめるため、型に合わない値もそのまま入れる */
const withChecks = (value: unknown): HarnessConfig => ({ ...unset, projectChecks: value as HarnessConfig['projectChecks'] });

const harnessChecks = (appId: number) => [
  { context: CHECKS.review, integration_id: appId },
  { context: CHECKS.mergeRoute, integration_id: appId },
  { context: CHECKS.planLink, integration_id: appId },
  { context: CHECKS.title, integration_id: appId },
  { context: CHECKS.tests, integration_id: appId },
];

/** 変更前の harness/scripts/setup.ts の rulesetBody が作っていた固定の内容 */
function fixedBody(appId: number) {
  return {
    name: 'agent-harness-main',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
          allowed_merge_methods: ['squash'],
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [{ context: 'ci', integration_id: 15368 }, ...harnessChecks(appId)],
        },
      },
    ],
  };
}

function requiredChecks(body: ReturnType<typeof rulesetBody>): unknown {
  const rule = (body.rules as { type: string; parameters?: { required_status_checks?: unknown } }[]).find((r) => r.type === 'required_status_checks');
  assert.ok(rule, 'required_status_checks の規則がある');
  return rule.parameters?.required_status_checks;
}

test('定数：Ruleset の名前と GitHub Actions の App ID', () => {
  assert.equal(RULESET_NAME, 'agent-harness-main');
  assert.equal(GITHUB_ACTIONS_APP_ID, 15368);
});

// ---- AC1：未設定なら今と同じ ----

test('projectChecks が未設定なら、rulesetBody は今の固定の内容と同じ（ci（15368）＋ハーネスの5つ）', () => {
  assert.deepEqual(projectChecks(unset), [{ context: 'ci', integrationId: 15368 }]);
  assert.deepEqual(rulesetBody(APP_ID, unset), fixedBody(APP_ID));
});

test('このリポジトリの harness.config.json で作る rulesetBody は、今の固定の内容と同じ', () => {
  assert.deepEqual(rulesetBody(APP_ID, loadConfig()), fixedBody(APP_ID));
});

// ---- AC2：2つ書くと両方が先に並び、integrationId を省くと 15368 ----

test('projectChecks に2つ書くと、2つともハーネスの5つより先に並び、integrationId を省いた方は 15368', () => {
  const config = withChecks([{ context: 'lint' }, { context: 'build', integrationId: 999 }]);
  assert.deepEqual(projectChecks(config), [
    { context: 'lint', integrationId: 15368 },
    { context: 'build', integrationId: 999 },
  ]);
  assert.deepEqual(requiredChecks(rulesetBody(APP_ID, config)), [
    { context: 'lint', integration_id: 15368 },
    { context: 'build', integration_id: 999 },
    ...harnessChecks(APP_ID),
  ]);
});

test('2つ書いたとき、rulesetSummary の文言に2つの名前と integrationId が入り、警告は無い', () => {
  const summary = rulesetSummary(APP_ID, withChecks([{ context: 'lint' }, { context: 'build', integrationId: 999 }]));
  for (const s of ['lint', 'build', '15368', '999', String(APP_ID)]) assert.ok(summary.text.includes(s), `${s} が文言にある: ${summary.text}`);
  assert.equal(summary.warning, null);
});

test('空の配列なら、必須チェックはハーネスの5つだけで、rulesetSummary が警告を返す', () => {
  const config = withChecks([]);
  assert.deepEqual(projectChecks(config), []);
  assert.deepEqual(requiredChecks(rulesetBody(APP_ID, config)), harnessChecks(APP_ID));
  const summary = rulesetSummary(APP_ID, config);
  assert.ok(summary.warning, '警告がある');
  assert.ok(summary.warning.includes('プロジェクトの CI を必須にしません'), summary.warning);
});

// ---- AC3：ハーネスのチェックと同じ名前はエラー（ほかの検査も） ----

test('ハーネスのチェックと同じ名前を書くとエラーになる', () => {
  for (const context of Object.values(CHECKS)) {
    assert.throws(() => projectChecks(withChecks([{ context }])), Error, context);
    assert.throws(() => rulesetBody(APP_ID, withChecks([{ context: 'ci' }, { context }])), Error, `rulesetBody: ${context}`);
  }
});

test('書式の誤りはエラーになる', () => {
  const bad: [string, unknown][] = [
    ['配列でない', { context: 'ci' }],
    ['配列でない（文字列）', 'ci'],
    ['要素がオブジェクトでない', ['ci']],
    ['要素が null', [null]],
    ['context が空', [{ context: '' }]],
    ['context が文字列でない', [{ context: 1 }]],
    ['context が無い', [{ integrationId: 1 }]],
    ['integrationId が 0', [{ context: 'ci', integrationId: 0 }]],
    ['integrationId が負', [{ context: 'ci', integrationId: -1 }]],
    ['integrationId が小数', [{ context: 'ci', integrationId: 1.5 }]],
    ['integrationId が文字列', [{ context: 'ci', integrationId: '15368' }]],
    ['context の重複', [{ context: 'ci' }, { context: 'ci', integrationId: 1 }]],
  ];
  for (const [name, value] of bad) assert.throws(() => projectChecks(withChecks(value)), Error, name);
});

test('loadConfig 自体は projectChecks を検査しない（検査は projectChecks で行う）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ruleset-'));
  try {
    const path = join(dir, 'harness.config.json');
    writeFileSync(path, JSON.stringify({ ...unset, projectChecks: [{ context: CHECKS.review }] }));
    const config = loadConfig(path);
    assert.throws(() => projectChecks(config));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- AC4：docs/setup.md に rulesetBody を直す手順が残っていない ----

test('docs/setup.md に rulesetBody を直す手順が無く、projectChecks の説明がある', () => {
  const setup = readFileSync(new URL('../../docs/setup.md', import.meta.url), 'utf8');
  assert.ok(!setup.includes('rulesetBody'), 'rulesetBody を直す手順が残っている');
  assert.ok(setup.includes('projectChecks'), 'projectChecks の説明が無い');
});
