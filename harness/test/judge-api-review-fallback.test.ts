// API のレビューの記録を使わずにローカルのレビューへ戻す場合（harness/lib/api-review.ts の selectApiReview と agent.ts api-review。Issue #1069）を確かめる。
// base のガードレールに当たる PR → guardrail-files、秘密扱いのファイル → secret-files、変更ファイルか base の設定を読めない → scope-unreadable、
// DRY_RUN・diff の切り捨て・記録の編集・前回のローカルのレビューのブロッキング → それぞれの理由の local、isSecretPathLike が review-api の isSecretPath と同じ規則であることを見る
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretPath } from '../../review-api/src/prompts.ts';
import { isSecretPathLike } from '../lib/api-review.ts';
import type { HarnessConfig } from '../lib/config.ts';
import type { IssueComment } from '../lib/github.ts';
import type { GuardrailConfig } from '../lib/guardrail.ts';
import { config, verdictComment } from './support/gate-fixtures.ts';
import {
  APP, BASE_DEPS, BASE_GUARDRAIL, CREATED_AT, FILES, OPEN, OTHER, PR, type Facts, type PrFile, type Scope,
  comment, fakeGh, judgeInputFile, loadCommand, postedBody, postedComment, select,
} from './support/judge-api-review.ts';

const URL7 = 'https://example.test/c7';
const withPrevious = (blocking: number, reviewSource: 'api' | 'local' | null): Facts => ({ state: 'open', previousHead: OTHER, previous: { blocking, reviewSource, headSha: OTHER, apiRecord: null } });
const scope = (files: string[] | null, baseGuardrail: GuardrailConfig | null = BASE_GUARDRAIL): Scope => ({ files, baseGuardrail });

test('selectApiReview：使える posted の記録があっても、範囲・記録の印・前回のブロッキングで local に戻す', () => {
  type Want = { action: string; reason?: string; recordUrl?: string };
  type Opts = { facts?: Facts; scope?: Scope };
  const posted = (marks: Parameters<typeof postedBody>[2] = {}, updatedAt = CREATED_AT) => [comment(7, postedBody(undefined, undefined, marks), undefined, updatedAt)];
  const cases: [string, IssueComment[], Want, Opts?][] = [
    // 前回の判定のブロッキング
    ['前回のローカルのレビューにブロッキング', posted(), { action: 'local', reason: 'previous-local-blocking' }, { facts: withPrevious(1, 'local') }],
    ['前回のレビューの出どころが不明でブロッキング', posted(), { action: 'local', reason: 'previous-local-blocking' }, { facts: withPrevious(2, null) }],
    ['前回のローカルのレビューにブロッキングなし', posted(), { action: 'api', recordUrl: URL7 }, { facts: withPrevious(0, 'local') }],
    // 範囲（変更ファイルと base のガードレール）
    ['変更ファイルを読めない', posted(), { action: 'local', reason: 'scope-unreadable' }, { scope: scope(null) }],
    ['base のガードレールを読めない', posted(), { action: 'local', reason: 'scope-unreadable' }, { scope: scope(FILES, null) }],
    ['base のガードレールに当たる', posted(), { action: 'local', reason: 'guardrail-files' }, { scope: scope(['src/app.ts', 'harness/lib/x.ts']) }],
    ['リネームの旧パスだけがガードレールに当たる', posted(), { action: 'local', reason: 'guardrail-files' }, { scope: scope(['docs/new.ts', 'harness/old.ts']) }],
    ['記録が無くてもガードレールに当たれば待たない', [], { action: 'local', reason: 'guardrail-files' }, { scope: scope(['harness/lib/x.ts']) }],
    ['秘密扱いのファイル', posted(), { action: 'local', reason: 'secret-files' }, { scope: scope(['harness/lib/.env.ts'], { guardrailPaths: ['docs/**'] }) }],
    // 記録の編集と印
    ['記録が編集された', posted({}, '2026-10-14T00:00:00Z'), { action: 'local', reason: 'record-edited', recordUrl: URL7 }],
    ['DRY_RUN の記録', posted({ dryRun: true }), { action: 'local', reason: 'dry-run', recordUrl: URL7 }],
    ['dryRun の欄が無い記録', posted({ dryRun: null }), { action: 'local', reason: 'dry-run', recordUrl: URL7 }],
    ['diff を切った記録', posted({ diffTruncated: true }), { action: 'local', reason: 'diff-truncated', recordUrl: URL7 }],
    ['diffTruncated の欄が無い記録', posted({ diffTruncated: null }), { action: 'local', reason: 'diff-truncated', recordUrl: URL7 }],
    ['どれにも当たらない', posted(), { action: 'api', recordUrl: URL7 }],
  ];
  for (const [name, comments, want, opts] of cases) {
    const got = select(comments, { facts: OPEN, ...opts }) as Want;
    assert.deepEqual({ action: got.action, reason: got.reason, recordUrl: got.recordUrl }, { recordUrl: undefined, reason: undefined, ...want }, name);
  }
});

test('api-review：前回の判定コメントにローカルのレビューのブロッキングがあれば、posted の記録があっても previous-local-blocking', async (t) => {
  const { apiReview } = await loadCommand();
  const previous = verdictComment({
    headSha: OTHER,
    review: { pass: false, blocking: [{ kind: 'bug', file: 'src/app.ts', detail: 'null で落ちる' }], nonBlocking: [] },
    metrics: { reviewSource: 'local' },
  }) as IssueComment;
  const file = judgeInputFile(t, [previous]);
  const { gh } = fakeGh(() => [previous, postedComment()]);
  const cfg = { ...config, reviewSource: { mode: 'api', waitMinutes: 8, appLogin: APP } } as unknown as HarnessConfig;
  const out = await apiReview(gh, cfg, PR, file, { now: () => 0, sleep: async () => assert.fail('待った'), samePatch: () => false, ...BASE_DEPS });
  assert.deepEqual(out, { action: 'local', reason: 'previous-local-blocking' });
});

test('api-review：PR の変更ファイル（リネームの旧パスを含む）と base のガードレールで guardrail-files・scope-unreadable', async (t) => {
  const { apiReview } = await loadCommand();
  const file = judgeInputFile(t);
  const cfg = { ...config, reviewSource: { mode: 'api', waitMinutes: 8, appLogin: APP } } as unknown as HarnessConfig;
  const cases: [string, { files?: PrFile[]; changedFiles?: number }, GuardrailConfig | null, string][] = [
    ['リネームの旧パスがガードレール', { files: [{ filename: 'docs/new.ts', previous_filename: 'harness/old.ts' }] }, BASE_GUARDRAIL, 'guardrail-files'],
    ['changed_files と一覧の件数が違う', { changedFiles: 2 }, BASE_GUARDRAIL, 'scope-unreadable'],
    ['base のガードレールを読めない', {}, null, 'scope-unreadable'],
  ];
  for (const [name, files, guardrail, reason] of cases) {
    const { gh, calls } = fakeGh(() => [postedComment()], files);
    const bases: string[] = [];
    const out = await apiReview(gh, cfg, PR, file, {
      now: () => 0,
      sleep: async () => assert.fail(`${name}: 待った`),
      samePatch: () => false,
      baseGuardrail: (base: string) => {
        bases.push(base);
        return guardrail;
      },
    });
    assert.deepEqual(out, { action: 'local', reason }, name);
    assert.deepEqual(bases, ['main'], `${name}: base のガードレールの読み方`);
    assert.ok(calls.includes(`paginate /pulls/${PR}/files`), `${name}: 変更ファイルを読んでいない`);
  }
});

test('isSecretPathLike：review-api の isSecretPath と同じパスを秘密扱いにする', () => {
  const paths = [
    '.env', 'app/.env.local', 'harness/lib/.env.ts', 'a/.dev.vars', 'certs/server.PEM', 'k.key', 'a.p12', 'b.pfx', 'home/id_rsa.pub', 'id_ed25519',
    '"quoted/.env"', 'win\\dir\\.env', 'src/app.ts', 'docs/environment.md', 'a/.envrc', 'dir/', '',
  ];
  for (const p of paths) assert.equal(isSecretPathLike(p), isSecretPath(p), p);
  assert.ok(paths.some((p) => isSecretPath(p)) && paths.some((p) => !isSecretPath(p)), '表に両方の場合がある');
});
