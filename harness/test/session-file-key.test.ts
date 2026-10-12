// Issue #708：セッションのファイル名の ID（harness/lib/session.ts の sessionFileKey）。クラウドの URL（CLAUDE_CODE_REMOTE_SESSION_ID）は最後の部分を
// session_… の名前にし、付き添いのセッションの ID はそのまま、形に当たらないもの（空・パスを抜ける ID・末尾が / の URL など）は null。
// URL のセッションで段階のファイル・見張りの記録が session_….json に書かれ、読み直せることも確かめる。
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { watchRecordPath } from '../lib/fleet-watch.ts';
import { sessionFileKey, sessionFromEnv } from '../lib/session.ts';
import { readStageFile, stageFilePath, writeStageFile, type StageFile } from '../lib/stage-file.ts';
import { SESSION } from './support/step-fixtures.ts';

test('sessionFileKey：URL は最後の部分（cse_ は session_ に読み替え）、付き添いの ID はそのまま、形に当たらなければ null', () => {
  const cases: [string | null, string | null][] = [
    ['https://claude.ai/code/session_X', 'session_X'],
    ['https://claude.ai/code/cse_X', 'session_X'],
    [SESSION, SESSION],
    ['session_X', 'session_X'],
    [null, null],
    ['', null],
    ['../escape', null],
    ['https://claude.ai/code/', null],
    ['https://claude.ai/code/session_X?x=1', null],
    ['https://claude.ai/code/session X', null],
    ['a.b', null],
  ];
  for (const [input, want] of cases) assert.equal(sessionFileKey(input), want, String(input));
});

test('CLAUDE_CODE_REMOTE_SESSION_ID のセッション：段階のファイルが stage/session_….json に書かれて読み直せ、見張りの記録も watch/session_….json', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'session-file-key-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const common = join(dir, 'common');
  const session = sessionFromEnv({ CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_abc123' });
  assert.equal(session, 'https://claude.ai/code/session_abc123');

  const path = stageFilePath(common, session);
  assert.equal(path, join(common, 'agent-harness', 'stage', 'session_abc123.json'));
  const value: StageFile = {
    version: 1,
    session: sessionFileKey(session)!,
    at: '2026-10-12T00:00:00.000Z',
    issue: 708,
    pr: null,
    node: 'plan',
    kind: 'node',
    branch: null,
    branchPrefix: 'claude/issue-708-',
    files: null,
    critique: null,
  };
  writeStageFile(path!, value);
  assert.deepEqual(readStageFile(path!), value);
  assert.deepEqual(readdirSync(join(common, 'agent-harness', 'stage')), ['session_abc123.json']);

  assert.equal(watchRecordPath(common, session), join(common, 'agent-harness', 'watch', 'session_abc123.json'));
});
