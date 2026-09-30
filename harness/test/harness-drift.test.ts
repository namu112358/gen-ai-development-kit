// Issue #199：読み込みの記録（harness/lib/harness-drift.ts）の純粋な部分。対象のパス・版（CRLF と LF で同じ）・記録のパスと読み書き、
// 3つの版（読み込み L・merge-base M・origin O）で比べる規則、fleet-status の表の下の1行、judge を止める文を確かめる。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  compareHarness,
  contentVersion,
  type DriftResult,
  driftLine,
  HARNESS_PATHS,
  isHarnessPath,
  judgeBlock,
  type LoadedRecord,
  loadedRecordPath,
  readLoadedRecord,
  writeLoadedRecordOnce,
} from '../lib/harness-drift.ts';

const SESSION = '3f2a9c1e-0b1d-4c2e-9f00-123456789abc';
const SKILL = '.claude/skills/ship/SKILL.md';
const FLEET = '.claude/skills/fleet/SKILL.md';
const RULES = 'harness/CLAUDE.harness.md';

const record = (patch: Partial<LoadedRecord> = {}): LoadedRecord => ({
  version: 1,
  session: SESSION,
  at: '2026-09-30T00:00:00Z',
  source: 'startup',
  head: 'a'.repeat(40),
  files: { [SKILL]: 'v1' },
  ...patch,
});

function tmp(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-drift-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---- 対象のパス ----

test('HARNESS_PATHS：CLAUDE.md・harness/CLAUDE.harness.md・.claude/agents/・.claude/skills/・.claude/settings.json', () => {
  assert.deepEqual([...HARNESS_PATHS].sort(), ['.claude/agents/', '.claude/settings.json', '.claude/skills/', 'CLAUDE.md', 'harness/CLAUDE.harness.md'].sort());
});

test('isHarnessPath：完全一致か、/ で終わる要素の下だけが対象', () => {
  for (const p of ['CLAUDE.md', RULES, SKILL, '.claude/agents/reviewer.md', '.claude/settings.json']) assert.equal(isHarnessPath(p), true, p);
  for (const p of ['README.md', 'harness/lib/step.ts', '.claude/hooks/session-env.ts', 'docs/CLAUDE.md', '.claude/skillsx/a.md', '.claude/settings.local.json', 'CLAUDE.md.bak']) {
    assert.equal(isHarnessPath(p), false, p);
  }
});

// ---- 版 ----

test('contentVersion：LF にそろえた中身の sha256（hex）。CRLF・CR・LF で同じ、中身が違えば違う', () => {
  const lf = contentVersion('a\nb\n');
  assert.equal(lf, createHash('sha256').update('a\nb\n').digest('hex'));
  assert.equal(contentVersion('a\r\nb\r\n'), lf);
  assert.equal(contentVersion('a\rb\r'), lf);
  assert.equal(contentVersion(new TextEncoder().encode('a\r\nb\r\n')), lf, 'Uint8Array でも同じ');
  assert.notEqual(contentVersion('a\nc\n'), lf);
});

// ---- 記録のパスと読み書き ----

test('loadedRecordPath：<共通ディレクトリ>/agent-harness/loaded/<ID>.json、ID が無い・形が違えば null', () => {
  assert.equal(loadedRecordPath('/repo/.git', SESSION), join('/repo/.git', 'agent-harness', 'loaded', `${SESSION}.json`));
  assert.equal(loadedRecordPath('/repo/.git', null), null);
  assert.equal(loadedRecordPath('/repo/.git', ''), null);
  assert.equal(loadedRecordPath('/repo/.git', 'https://claude.ai/code/session_x'), null);
  assert.equal(loadedRecordPath('/repo/.git', '../escape'), null, 'パスを抜ける ID は使わない');
});

test('writeLoadedRecordOnce → readLoadedRecord で同じ中身。ディレクトリが無くても作る。2回目は書かず false（上書きしない）', (t) => {
  const dir = tmp(t);
  const path = loadedRecordPath(join(dir, 'common'), SESSION)!;
  assert.equal(writeLoadedRecordOnce(path, record()), true);
  assert.deepEqual(readLoadedRecord(path), record());
  assert.equal(writeLoadedRecordOnce(path, record({ files: { [SKILL]: 'v2' } })), false);
  assert.deepEqual(readLoadedRecord(path)!.files, { [SKILL]: 'v1' }, '最初の記録のまま（resume・compact で新しく見せない）');
});

test('readLoadedRecord：無い・JSON でない・書式が違うときは null', (t) => {
  const dir = tmp(t);
  assert.equal(readLoadedRecord(join(dir, 'none.json')), null);
  const bad = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };
  assert.equal(readLoadedRecord(bad('broken.json', '{not json')), null);
  assert.equal(readLoadedRecord(bad('v2.json', JSON.stringify({ ...record(), version: 2 }))), null, '版が違う');
  assert.equal(readLoadedRecord(bad('nofiles.json', JSON.stringify({ ...record(), files: undefined }))), null, 'files が無い');
  assert.equal(readLoadedRecord(bad('badfiles.json', JSON.stringify({ ...record(), files: { [SKILL]: 1 } }))), null, 'files の値が文字列でない');
  assert.equal(readLoadedRecord(bad('array.json', '[]')), null);
  mkdirSync(join(dir, 'isdir.json'));
  assert.equal(readLoadedRecord(join(dir, 'isdir.json')), null, '読めない');
});

test('readLoadedRecord：head が null の記録も読める', (t) => {
  const dir = tmp(t);
  const p = join(dir, 'r.json');
  writeFileSync(p, JSON.stringify(record({ head: null, source: null })));
  assert.deepEqual(readLoadedRecord(p), record({ head: null, source: null }));
  assert.ok(readFileSync(p, 'utf8').length > 0);
});

// ---- 比べる規則（L と O だけ・M なし） ----

const fresh: DriftResult = { stale: false, changed: [], added: [], removed: [] };

test('compareHarness：同じ → 古くない', () => {
  assert.deepEqual(compareHarness({ [SKILL]: 'v1', [RULES]: 'r1' }, { [SKILL]: 'v1', [RULES]: 'r1' }, null), fresh);
  assert.deepEqual(compareHarness({}, {}, null), fresh);
});

test('compareHarness（M なし）：中身の違い → changed、origin に増えた → added、消えた → removed。どれも古い。配列は昇順', () => {
  const r = compareHarness({ [SKILL]: 'v1', [FLEET]: 'f1', 'CLAUDE.md': 'x' }, { [SKILL]: 'v2', [FLEET]: 'f2', [RULES]: 'r1' }, null);
  assert.equal(r.stale, true);
  assert.deepEqual(r.changed, [FLEET, SKILL].sort());
  assert.deepEqual(r.added, [RULES]);
  assert.deepEqual(r.removed, ['CLAUDE.md']);
  assert.deepEqual(compareHarness({ [SKILL]: 'v1' }, { [SKILL]: 'v1', [RULES]: 'r1' }, null), { stale: true, changed: [], added: [RULES], removed: [] });
  assert.deepEqual(compareHarness({ [SKILL]: 'v1', [RULES]: 'r1' }, { [SKILL]: 'v1' }, null), { stale: true, changed: [], added: [], removed: [RULES] });
});

// ---- 3つの版の規則 ----

test('compareHarness：ブランチが自分で変えたファイル（L≠M）を origin が変えていない（O=M）→ 古くない', () => {
  assert.deepEqual(compareHarness({ [SKILL]: 'mine' }, { [SKILL]: 'base' }, { [SKILL]: 'base' }), fresh);
});

test('compareHarness：ブランチが自分で足したファイル（M・O に無い）→ 古くない。ブランチが消したファイル（L に無い、M=O）→ 古くない', () => {
  assert.deepEqual(compareHarness({ [SKILL]: 'new' }, {}, {}), fresh);
  assert.deepEqual(compareHarness({}, { [SKILL]: 'base' }, { [SKILL]: 'base' }), fresh);
});

test('compareHarness：ブランチが変えたファイルを origin もその後に変えた（L≠M、O≠M）→ 古い（changed）', () => {
  assert.deepEqual(compareHarness({ [SKILL]: 'mine' }, { [SKILL]: 'theirs' }, { [SKILL]: 'base' }), { stale: true, changed: [SKILL], added: [], removed: [] });
});

test('compareHarness：ブランチが変えていないファイル（L=M）を origin が変えた → 古い（本体が origin より古いまま始めた場合もこれ）', () => {
  assert.deepEqual(compareHarness({ [SKILL]: 'base' }, { [SKILL]: 'theirs' }, { [SKILL]: 'base' }), { stale: true, changed: [SKILL], added: [], removed: [] });
  assert.deepEqual(compareHarness({}, { [RULES]: 'r1' }, {}), { stale: true, changed: [], added: [RULES], removed: [] }, 'origin に増えた');
  assert.deepEqual(compareHarness({ [RULES]: 'r1' }, {}, { [RULES]: 'r1' }), { stale: true, changed: [], added: [], removed: [RULES] }, 'origin で消えた');
});

test('compareHarness：ブランチが1つを変え、origin は別のファイルを変えた → そのファイルだけが古い', () => {
  const r = compareHarness({ [SKILL]: 'mine', [FLEET]: 'f-base' }, { [SKILL]: 's-base', [FLEET]: 'f-new' }, { [SKILL]: 's-base', [FLEET]: 'f-base' });
  assert.deepEqual(r, { stale: true, changed: [FLEET], added: [], removed: [] });
});

test('compareHarness：M が null なら L と O だけで比べる（安全側）', () => {
  assert.deepEqual(compareHarness({ [SKILL]: 'mine' }, { [SKILL]: 'base' }, null), { stale: true, changed: [SKILL], added: [], removed: [] });
});

// ---- 表示の1行 ----

test('driftLine：古いときだけ1行（「このセッションの読み込みは古い」・件数・先頭のパス・「段階の切れ目で交代する」）', () => {
  const stale: DriftResult = { stale: true, changed: [FLEET, SKILL], added: [RULES], removed: [] };
  const line = driftLine(stale);
  assert.ok(!line.includes('\n'), '1行');
  for (const w of ['このセッションの読み込みは古い', '段階の切れ目で交代する', '3', FLEET]) assert.ok(line.includes(w), `「${w}」がありません: ${line}`);
});

test('driftLine：判断しない（null）・古くないときは空文字（今の出力と同じ）', () => {
  assert.equal(driftLine(null), '');
  assert.equal(driftLine(fresh), '');
});

test('driftLine：変わったファイルが多くても1行に収め、全件は並べない（先頭の数件）', () => {
  const many = Array.from({ length: 30 }, (_, i) => `.claude/skills/s${String(i).padStart(2, '0')}/SKILL.md`);
  const line = driftLine({ stale: true, changed: many, added: [], removed: [] });
  assert.ok(!line.includes('\n'));
  assert.ok(line.includes('30'), '件数');
  assert.ok(line.includes(many[0]!), '先頭のパス');
  assert.ok(!line.includes(many[29]!), '全件は並べない');
});

// ---- judge を止める文 ----

test('judgeBlock：段階が judge で古いときだけ文（「読み込みが古い」「ハーネスが更新されたときの交代」を含む）', () => {
  const stale: DriftResult = { stale: true, changed: [SKILL], added: [], removed: [] };
  const text = judgeBlock('judge', stale);
  assert.ok(text !== null);
  assert.ok(text.includes('読み込みが古い'), text);
  assert.ok(text.includes('ハーネスが更新されたときの交代'), text);
});

test('judgeBlock：ほかの段階・段階なし・判断しない・古くないときは null', () => {
  const stale: DriftResult = { stale: true, changed: [SKILL], added: [], removed: [] };
  for (const stage of ['plan', 'plan-critique', 'plan-gate', 'implement', 'fix', 'sync', undefined]) assert.equal(judgeBlock(stage, stale), null, String(stage));
  assert.equal(judgeBlock('judge', null), null);
  assert.equal(judgeBlock('judge', fresh), null);
});
