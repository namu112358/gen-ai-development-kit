// judge の API のレビューの選び方（harness/lib/api-review.ts）と agent.ts api-review のテストが共有する見本：
// review-api の記録のコメント（posted・止めた記録）、selectApiReview の呼び出し、judge-input のファイル、偽の GitHub（#1042・#1069）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { renderShadowComment, renderStoppedComment, type StoppedOutcome } from '../../../review-api/src/record.ts';
import { composeShadowVerdict, type ReviewerOutput, type RiskOutput } from '../../../review-api/src/verdict.ts';
import { selectApiReview } from '../../lib/api-review.ts';
import type { GitHub, IssueComment } from '../../lib/github.ts';
import type { GuardrailConfig } from '../../lib/guardrail.ts';
import { renderJudgeInput } from '../../lib/session-inputs.ts';
import { RISK_QUESTIONS } from '../../lib/verdict.ts';
import { config } from './gate-fixtures.ts';

export const PR = 5;
export const HEAD = 'a'.repeat(40);
export const OTHER = 'b'.repeat(40);
export const APP = 'review-api[bot]';
export const MODELS = { review: 'claude-opus-5-5', risk: 'claude-sonnet-5-5' };
export const CREATED_AT = '2026-10-13T00:00:00Z';

export const REVIEWER: ReviewerOutput = { pass: false, blocking: [{ kind: 'bug', file: 'src/a.ts', detail: 'null で落ちる' }], nonBlocking: ['命名'] };
/** 合格の Reviewer（コマンドのテストで composeVerdict に渡す） */
export const PASSING_REVIEWER: ReviewerOutput = { pass: true, blocking: [], nonBlocking: ['命名'] };
export const RISK: RiskOutput = {
  level: 'low',
  answers: Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe])) as RiskOutput['answers'],
  rationale: 'docs のみ',
  facts: { references: 'none', tests: 'none', fileKinds: 'docs' },
};

/** 判定する PR の既定の変更ファイルと、base のガードレール（どちらも当たらない組み合わせ） */
export const FILES = ['src/app.ts'];
export const BASE_GUARDRAIL: GuardrailConfig = { guardrailPaths: ['harness/**'] };
/** apiReview の deps に足す base のガードレールの読み方（本物の git fetch・git show を流さない） */
export const BASE_DEPS = { baseGuardrail: (_base: string): GuardrailConfig | null => ({ guardrailPaths: ['harness/**'] }) };

/** posted の記録の印。undefined は既定の false、null は欄を書かない（古い記録） */
export interface PostedMarks {
  diffTruncated?: boolean | null;
  dryRun?: boolean | null;
  reviewer?: ReviewerOutput;
}

const mark = (key: 'diffTruncated' | 'dryRun', v: boolean | null | undefined) => (v === null ? {} : { [key]: v ?? false });

export const postedBody = (headSha = HEAD, pr = PR, marks: PostedMarks = {}): string =>
  renderShadowComment({
    version: 1, pr, headSha,
    verdict: composeShadowVerdict({ pr, headSha, reviewer: marks.reviewer ?? REVIEWER, risk: RISK, model: MODELS.review }),
    models: MODELS, usage: {}, usd: null, durationSec: 1,
    ...mark('diffTruncated', marks.diffTruncated),
    ...mark('dryRun', marks.dryRun),
  });
export const stoppedBody = (outcome: StoppedOutcome, headSha = HEAD, pr = PR): string => renderStoppedComment({ version: 1, pr, headSha, outcome, usd: null });

/** コメント。updatedAt の既定は created_at と同じ（編集されていない） */
export const comment = (id: number, body: string, user: IssueComment['user'] = { login: APP, type: 'Bot' }, updatedAt = CREATED_AT): IssueComment => ({
  id, body, html_url: `https://example.test/c${id}`, created_at: CREATED_AT, updated_at: updatedAt, author_association: 'NONE', user,
});

/** コマンドのテストの posted の記録（id 7、合格の Reviewer） */
export const postedComment = (marks: PostedMarks = {}): IssueComment => comment(7, postedBody(HEAD, PR, { reviewer: PASSING_REVIEWER, ...marks }));

export type Facts = { state: string | null; previousHead: string | null; previous?: { blocking: number; reviewSource: 'api' | 'local' | null; headSha: string; apiRecord: string | null } | null };
export type Scope = { files: string[] | null; baseGuardrail: GuardrailConfig | null };
export const OPEN: Facts = { state: 'open', previousHead: null };

export const select = (comments: IssueComment[], opts: { facts?: Facts; samePatch?: (h: string) => boolean; scope?: Scope } = {}) =>
  selectApiReview({
    pr: PR, judgedHead: HEAD, appLogin: APP, comments,
    facts: opts.facts ?? OPEN,
    samePatch: opts.samePatch ?? (() => false),
    scope: opts.scope ?? { files: FILES, baseGuardrail: BASE_GUARDRAIL },
  });

/** judge-input のファイル（PR は open）。prComments に前回の判定のコメントを渡せる（既定は無し） */
export function judgeInputFile(t: TestContext, prComments: IssueComment[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'api-review-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'judge-input.txt');
  writeFileSync(file, renderJudgeInput(config, { pr: { number: PR, headSha: HEAD, body: '' }, issues: [], prComments, checkRuns: [], prState: { state: 'open', draft: true } }));
  return file;
}

/** PR の変更ファイル（/pulls/<n>/files の要素） */
export type PrFile = { filename: string; previous_filename?: string };

/**
 * get('/pulls/5')・paginate('/pulls/5/files')・listComments(5) だけに答える偽の GitHub。呼び出しを数え、ほかのメソッドは呼ばれたら投げる。
 * files の既定は src/app.ts の1件。changedFiles の既定は files の件数（食い違わせるときに渡す）
 */
export function fakeGh(comments: () => IssueComment[], opts: { files?: PrFile[]; changedFiles?: number } = {}): { gh: GitHub; calls: string[] } {
  const calls: string[] = [];
  const files = opts.files ?? FILES.map((filename) => ({ filename }));
  const impl: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    async get(path) {
      calls.push(`get ${String(path)}`);
      assert.equal(path, `/pulls/${PR}`);
      return {
        number: PR, state: 'open', draft: true, changed_files: opts.changedFiles ?? files.length,
        head: { ref: 'claude/issue-1-x', sha: HEAD }, base: { ref: 'main', sha: 'c'.repeat(40) },
      };
    },
    async paginate(path) {
      calls.push(`paginate ${String(path)}`);
      assert.equal(path, `/pulls/${PR}/files`);
      return files.map((f) => ({ additions: 1, deletions: 0, ...f }));
    },
    async listComments(n) {
      calls.push(`listComments ${String(n)}`);
      assert.equal(n, PR);
      return comments();
    },
  };
  const gh = new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target) return target[prop];
      if (prop === 'then') return undefined;
      throw new Error(`偽の GitHub：想定外の呼び出し ${String(prop)}`);
    },
  }) as unknown as GitHub;
  return { gh, calls };
}

/** commands/api-review.ts は cli.ts を通して harness.config.json を読むので、使うときだけ読み込む */
export const loadCommand = () => import('../../scripts/agent/commands/api-review.ts');
