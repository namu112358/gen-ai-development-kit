// 前回の判定が API のレビューでブロッキングを持つとき、その記録（apiRecord の URL のコメント）を確かめられたときだけ API のレビューに進むこと
// （harness/lib/api-review.ts の selectApiReview。Issue #1080）を確かめる。確かめられなければ previous-local-blocking に戻す
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IssueComment } from '../lib/github.ts';
import { APP, OTHER, type Facts, comment, postedBody, select, stoppedBody } from './support/judge-api-review.ts';

const PREV_URL = 'https://example.test/c6';
const facts = (apiRecord: string | null): Facts => ({ state: 'open', previousHead: OTHER, previous: { blocking: 1, reviewSource: 'api', headSha: OTHER, apiRecord } });
/** 判定する head の posted の記録（id 7） */
const current = comment(7, postedBody());

test('selectApiReview：前回の API のレビューのブロッキングは、記録を確かめられたときだけ api、ほかは previous-local-blocking', () => {
  type Want = { action: string; reason?: string; recordUrl?: string };
  const cases: [string, IssueComment[], string | null, Want][] = [
    ['記録を確かめられる', [comment(6, postedBody(OTHER)), current], PREV_URL, { action: 'api', recordUrl: 'https://example.test/c7' }],
    ['apiRecord が無い', [comment(6, postedBody(OTHER)), current], null, { action: 'local', reason: 'previous-local-blocking' }],
    ['同じ URL のコメントが無い', [comment(6, postedBody(OTHER)), current], 'https://example.test/c99', { action: 'local', reason: 'previous-local-blocking' }],
    ['ほかの名義の記録', [comment(6, postedBody(OTHER), { login: 'other[bot]', type: 'Bot' }), current], PREV_URL, { action: 'local', reason: 'previous-local-blocking' }],
    ['Bot でない同じ名義', [comment(6, postedBody(OTHER), { login: APP, type: 'User' }), current], PREV_URL, { action: 'local', reason: 'previous-local-blocking' }],
    ['記録の head が前回の head と違う', [comment(6, postedBody('d'.repeat(40))), current], PREV_URL, { action: 'local', reason: 'previous-local-blocking' }],
    ['同じ URL が止めた記録', [comment(6, stoppedBody('too-large', OTHER)), current], PREV_URL, { action: 'local', reason: 'previous-local-blocking' }],
  ];
  for (const [name, comments, apiRecord, want] of cases) {
    const got = select(comments, { facts: facts(apiRecord) }) as Want;
    assert.deepEqual({ action: got.action, reason: got.reason, recordUrl: got.recordUrl }, { recordUrl: undefined, reason: undefined, ...want }, name);
  }
});
