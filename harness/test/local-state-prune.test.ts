// Issue #654：手元の状態のファイルの片付け（.claude/hooks/session-env.ts の pruneSessionFiles）。
// 30日より前の loaded・watch・stage の <ID>.json が消え、新しいもの・自分の ID のもの・stage か watch が新しい ID の loaded は残ること。
// 60分より前の *.tmp は hq/ を含めて消え、hq/ の .json と hq/pending/ の中は残ること。rm の失敗（EPERM・EBUSY・ENOENT）で止まらないこと。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { test } from 'node:test';
import { pruneSessionFiles, SESSION_FILE_MAX_AGE_DAYS, STALE_TMP_MINUTES, type PruneIo } from '../../.claude/hooks/session-env.ts';

const NOW = new Date('2026-10-11T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const OLD = (SESSION_FILE_MAX_AGE_DAYS + 10) * DAY;
const RECENT = (SESSION_FILE_MAX_AGE_DAYS - 1) * DAY;
const OLD_TMP = (STALE_TMP_MINUTES + 1) * MIN;
const RECENT_TMP = (STALE_TMP_MINUTES - 1) * MIN;

const ME = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const GONE = '11111111-1111-4111-8111-111111111111';
const FRESH = '22222222-2222-4222-8222-222222222222';
const BY_STAGE = '33333333-3333-4333-8333-333333333333';
const BY_WATCH = '44444444-4444-4444-8444-444444444444';

function tempCommon(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-state-prune-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** commonDir/agent-harness/<rel> を、NOW から ageMs 前の更新時刻で作る */
function put(commonDir: string, rel: string, ageMs: number): string {
  const path = join(commonDir, 'agent-harness', ...rel.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{}');
  const at = new Date(NOW.getTime() - ageMs);
  utimesSync(path, at, at);
  return path;
}

/** agent-harness の下に残ったファイルの相対パス（/ 区切り、並べ替えたもの） */
function remaining(commonDir: string): string[] {
  const base = join(commonDir, 'agent-harness');
  return readdirSync(base, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(base, rel)).isFile())
    .map((rel) => rel.split(sep).join('/'))
    .sort();
}

test('古いほかの ID の loaded・watch・stage と古い *.tmp だけが消え、新しいもの・自分の ID・stage か watch が新しい ID の loaded・hq の .json・hq/pending は残る', (t) => {
  const common = tempCommon(t);
  for (const kind of ['loaded', 'watch', 'stage']) {
    put(common, `${kind}/${GONE}.json`, OLD);
    put(common, `${kind}/${FRESH}.json`, RECENT);
    put(common, `${kind}/${ME}.json`, OLD);
  }
  put(common, `loaded/${BY_STAGE}.json`, OLD);
  put(common, `stage/${BY_STAGE}.json`, DAY);
  put(common, `loaded/${BY_WATCH}.json`, OLD);
  put(common, `watch/${BY_WATCH}.json`, DAY);
  put(common, 'loaded/notes.txt', OLD);
  for (const kind of ['loaded', 'watch', 'stage', 'hq']) {
    put(common, `${kind}/old.json.123.tmp`, OLD_TMP);
    put(common, `${kind}/new.json.456.tmp`, RECENT_TMP);
  }
  put(common, 'hq/ledger.json', OLD);
  put(common, 'hq/pending/q1.json', OLD);
  put(common, 'hq/pending/q2.json.789.tmp', OLD);

  pruneSessionFiles(common, { now: NOW, keepSession: ME });

  assert.deepEqual(remaining(common), [
    'hq/ledger.json',
    'hq/new.json.456.tmp',
    'hq/pending/q1.json',
    'hq/pending/q2.json.789.tmp',
    `loaded/${BY_STAGE}.json`,
    `loaded/${BY_WATCH}.json`,
    `loaded/${FRESH}.json`,
    `loaded/${ME}.json`,
    'loaded/new.json.456.tmp',
    'loaded/notes.txt',
    `stage/${BY_STAGE}.json`,
    `stage/${FRESH}.json`,
    `stage/${ME}.json`,
    'stage/new.json.456.tmp',
    `watch/${BY_WATCH}.json`,
    `watch/${FRESH}.json`,
    `watch/${ME}.json`,
    'watch/new.json.456.tmp',
  ].sort());
});

test('rm が EPERM・EBUSY・ENOENT で失敗するファイルは飛ばし、例外を投げずにほかの古いファイルを消す', (t) => {
  const common = tempCommon(t);
  const failing: Record<string, string> = {
    [`${GONE}.json`]: 'EPERM',
    [`${FRESH}.json`]: 'EBUSY',
    'old.json.1.tmp': 'ENOENT',
  };
  const kept = [put(common, `loaded/${GONE}.json`, OLD), put(common, `watch/${FRESH}.json`, OLD), put(common, 'hq/old.json.1.tmp', OLD_TMP)];
  const removed = [put(common, `stage/${BY_STAGE}.json`, OLD), put(common, 'stage/old.json.2.tmp', OLD_TMP)];
  const io: Partial<PruneIo> = {
    rmSync: (path: string, opts: { force: boolean }) => {
      const code = failing[basename(path)];
      if (code) throw Object.assign(new Error(`fake ${code}`), { code });
      rmSync(path, opts);
    },
  };

  assert.doesNotThrow(() => pruneSessionFiles(common, { now: NOW, keepSession: ME, io }));
  assert.deepEqual(removed.filter((p) => existsSync(p)), [], 'ほかの古いファイルが消えていない');
  assert.deepEqual(kept.filter((p) => !existsSync(p)), [], '失敗したファイルは残る');
});
