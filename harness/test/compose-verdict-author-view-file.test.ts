// compose-verdict の --author-view のファイルを readAuthorViewFile で読み、前後の空白・改行（CRLF を含む）を除き、中の改行は残し、
// 空白だけ・空のファイルは空文字になって composeVerdict が誤りにすることを確かめる（Issue #449）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { composeVerdict, readAuthorViewFile, type ComposeInput } from '../lib/session-inputs.ts';
import { RISK_QUESTIONS } from '../lib/verdict.ts';
import { HEAD } from './support/gate-fixtures.ts';

const dir = mkdtempSync(join(tmpdir(), 'author-view-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const fileWith = (name: string, text: string): string => {
  const file = join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
};

const answers = Object.fromEntries(RISK_QUESTIONS.map((q) => [q.key, q.safe]));
const risk = { level: 'low', answers, rationale: 'docs のみ', facts: { references: 'none', tests: 'none', fileKinds: 'docs' } };
const input = (patch: Partial<ComposeInput> = {}): ComposeInput => ({
  pr: 5, judgedHead: HEAD, currentHead: HEAD, reviewer: { pass: true, blocking: [], nonBlocking: [] }, risk, meta: { model: 'm', judgedBy: '付き添いのセッション' }, ...patch,
});

test('readAuthorViewFile：前後の空白・改行（CRLF を含む）を除き、中の改行は残す', () => {
  const cases: [string, string, string][] = [
    ['lf', '\n  一行目\n二行目  \n\n', '一行目\n二行目'],
    ['crlf', '\r\n\t一行目\r\n二行目\r\n\r\n', '一行目\r\n二行目'],
    ['そのまま', '見解です。', '見解です。'],
  ];
  for (const [name, text, want] of cases) assert.equal(readAuthorViewFile(fileWith(`${name}.txt`, text)), want, name);
});

test('readAuthorViewFile：空白だけ・空のファイルは空文字を返し、composeVerdict はその見解を誤りにする', () => {
  for (const [name, text] of [['blank', ' \r\n\t \n'], ['empty', '']] as [string, string][]) {
    const view = readAuthorViewFile(fileWith(`${name}.txt`, text));
    assert.equal(view, '', name);
    assert.equal(composeVerdict(input({ authorView: view })).ok, false, name);
  }
});
