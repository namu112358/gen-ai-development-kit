// Issue #414：見直しの loop（test-prune・qa-retro・patrol）の状態のファイルの読み書きの補助（harness/lib/local-state-loop.ts）。
// 3つのスクリプトが同じ補助を通ること（本文を読んで確かめる）、読んだ後にほかのセッションが書いていたら上書きせずに止まること（鍵を含む）、
// 書き込みに失敗したとき一時ファイル・鍵を残さないこと（io の差し替えで失敗を起こす）、読み込みと引数の誤り。
// 一時ファイル経由の書き込みのやり直しそのものは local-state-write.test.ts、各スクリプトのサブコマンドの振る舞いは
// test-prune-loop・qa-retro-loop・patrol のテスト、時期を過ぎた見直しの並べ方は patrol.test.ts に任せる。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LocalStateIo } from '../lib/local-state.ts';
import { loadLoopState, parseLoopArgs, saveLoopState } from '../lib/local-state-loop.ts';
import { readText } from './support/skill-text.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-state-loop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const codeError = (code: string): Error => Object.assign(new Error(`fake ${code}`), { code });
const tmpLeft = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'));
const lockLeft = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.lock'));

// 名前の変更を毎回 code 付きで失敗させる（やり直しても失敗し続ける）か、一時ファイルへの書き込みを書きかけで ENOSPC にする。sleep は待たない。
function fakeIo(opts: { renameCode?: string; writeFails?: boolean }): Partial<LocalStateIo> {
  const io: Partial<LocalStateIo> = { sleep: () => {} };
  if (opts.renameCode !== undefined) {
    const code = opts.renameCode;
    io.renameSync = (() => {
      throw codeError(code);
    }) as LocalStateIo['renameSync'];
  }
  if (opts.writeFails) {
    io.writeFileSync = ((p: string, data: string) => {
      writeFileSync(p, String(data).slice(0, 1)); // 書きかけを残してから失敗する
      throw codeError('ENOSPC');
    }) as LocalStateIo['writeFileSync'];
  }
  return io;
}

interface S {
  version: 1;
  n: number;
}

// テスト用の状態の parse（各スクリプトの parse*State と同じ形の Result を返す）
function parseS(text: string | null): { ok: true; state: S | null } | { ok: false; errors: string[] } {
  if (text === null) return { ok: true, state: null };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`JSON として読めません：${(e as Error).message}`] };
  }
  const o = v as { version?: unknown; n?: unknown } | null;
  if (o === null || typeof o !== 'object' || o.version !== 1 || typeof o.n !== 'number') return { ok: false, errors: ['形が違います'] };
  return { ok: true, state: { version: 1, n: o.n } };
}

const stateText = (s: S): string => `${JSON.stringify(s, null, 2)}\n`;

function load(path: string, hint?: string) {
  const r = loadLoopState<S>(path, parseS, hint);
  assert.ok(r.ok, `読み込みに失敗: ${r.ok ? '' : r.errors.join(' / ')}`);
  return r.snapshot;
}

// --- 呼び出し元 ---

const LOOPS = ['harness/scripts/test-prune-loop.ts', 'harness/scripts/qa-retro-loop.ts', 'harness/scripts/patrol.ts'];
const OWN_FUNCTIONS = ['loadState', 'saveState', 'readText', 'writeAtomic', 'parseArgs', 'fail'];
// qa-retro-loop.ts は data の集計を OS の一時ディレクトリに書くので writeFileSync の検査から除く
const NO_WRITE_FILE = ['harness/scripts/test-prune-loop.ts', 'harness/scripts/patrol.ts'];

test('3つの loop は local-state-loop.ts から import し、renameSync を呼ばず、読み書き・引数・誤りの関数を自分で持たない', () => {
  const problems: string[] = [];
  for (const file of LOOPS) {
    const text = readText(file);
    if (!/from '\.\.\/lib\/local-state-loop\.ts'/.test(text)) problems.push(`${file}: local-state-loop.ts からの import が無い`);
    if (text.includes('renameSync(')) problems.push(`${file}: renameSync( を直接呼んでいる`);
    for (const name of OWN_FUNCTIONS) if (text.includes(`function ${name}(`)) problems.push(`${file}: function ${name} を自分で持っている`);
    if (NO_WRITE_FILE.includes(file) && text.includes('writeFileSync(')) problems.push(`${file}: writeFileSync( を直接呼んでいる`);
  }
  assert.deepEqual(problems, []);
});

// --- 書ける場合 ---

test('saveLoopState：読んだ後に変わっていなければ、2字下げの JSON と末尾の改行で書け、一時ファイルも鍵も残らない（無いファイルから初めて書く場合も）', async (t) => {
  const cases: { name: string; before: S | null }[] = [
    { name: '既にあるファイル', before: { version: 1, n: 1 } },
    { name: '無いファイル', before: null },
  ];
  for (const c of cases) {
    await t.test(c.name, (st) => {
      const dir = tempDir(st);
      const path = join(dir, 'loop.json');
      if (c.before) writeFileSync(path, stateText(c.before));
      const snap = load(path);
      assert.equal(snap.text, c.before ? stateText(c.before) : null);
      const next: S = { version: 1, n: 2 };
      const r = saveLoopState(snap, next);
      assert.ok(r.ok, `書けない: ${r.ok ? '' : r.errors.join(' / ')}`);
      assert.equal(readFileSync(path, 'utf8'), stateText(next));
      assert.deepEqual(tmpLeft(dir), []);
      assert.deepEqual(lockLeft(dir), []);
    });
  }
});

test('saveLoopState：変わっていなければ追加のファイル（extra）も状態も書く', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'loop.json');
  const extra = join(dir, 'observe.json');
  writeFileSync(path, stateText({ version: 1, n: 1 }));
  const snap = load(path);
  const r = saveLoopState(snap, { version: 1, n: 2 }, { extra: [{ path: extra, content: '{"observed":true}\n' }] });
  assert.ok(r.ok, `書けない: ${r.ok ? '' : r.errors.join(' / ')}`);
  assert.equal(readFileSync(extra, 'utf8'), '{"observed":true}\n');
  assert.equal(readFileSync(path, 'utf8'), stateText({ version: 1, n: 2 }));
  assert.deepEqual(lockLeft(dir), []);
});

// --- 競合 ---

test('saveLoopState：読んだ後にほかのセッションが書いていたら、上書きせずに ok: false で止まり、一時ファイルも鍵も残さない', async (t) => {
  const cases: { name: string; before: S | null; other: S }[] = [
    { name: '読んだ後に中身が変わった', before: { version: 1, n: 1 }, other: { version: 1, n: 99 } },
    { name: '読んだときに無かったファイルが書く前にできていた', before: null, other: { version: 1, n: 99 } },
  ];
  for (const c of cases) {
    await t.test(c.name, (st) => {
      const dir = tempDir(st);
      const path = join(dir, 'loop.json');
      if (c.before) writeFileSync(path, stateText(c.before));
      const snap = load(path);
      writeFileSync(path, stateText(c.other)); // ほかのセッションが書いた
      const r = saveLoopState(snap, { version: 1, n: 2 });
      assert.equal(r.ok, false);
      if (!r.ok) {
        const msg = r.errors.join('\n');
        assert.ok(msg.includes('ほかのセッション'), `誤りの文に「ほかのセッション」が無い: ${msg}`);
        assert.ok(msg.includes(path), `誤りの文にパスが無い: ${msg}`);
      }
      assert.equal(readFileSync(path, 'utf8'), stateText(c.other));
      assert.deepEqual(tmpLeft(dir), []);
      assert.deepEqual(lockLeft(dir), []);
    });
  }
});

test('saveLoopState：競合のときは追加のファイル（extra）も書かない（前の中身のまま）', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'loop.json');
  const extra = join(dir, 'observe.json');
  writeFileSync(path, stateText({ version: 1, n: 1 }));
  writeFileSync(extra, 'old observe');
  const snap = load(path);
  writeFileSync(path, stateText({ version: 1, n: 99 }));
  const r = saveLoopState(snap, { version: 1, n: 2 }, { extra: [{ path: extra, content: 'new observe' }] });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(extra, 'utf8'), 'old observe');
  assert.equal(readFileSync(path, 'utf8'), stateText({ version: 1, n: 99 }));
  assert.deepEqual(tmpLeft(dir), []);
  assert.deepEqual(lockLeft(dir), []);
});

test('saveLoopState：鍵（<path>.lock）が既にあれば ok: false（誤りの文に鍵のパス）で、状態のファイルは変えず、既にあった鍵も消さない', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'loop.json');
  const lock = `${path}.lock`;
  writeFileSync(path, stateText({ version: 1, n: 1 }));
  const snap = load(path);
  writeFileSync(lock, 'held by another session');
  const r = saveLoopState(snap, { version: 1, n: 2 });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.join('\n').includes(lock), `誤りの文に鍵のパスが無い: ${r.errors.join(' / ')}`);
  assert.equal(readFileSync(path, 'utf8'), stateText({ version: 1, n: 1 }));
  assert.equal(existsSync(lock), true);
  assert.equal(readFileSync(lock, 'utf8'), 'held by another session');
  assert.deepEqual(tmpLeft(dir), []);
});

// --- 書き込みの失敗 ---

test('saveLoopState：書き込みに失敗したら ok: false で、一時ファイルも鍵も残さず、元のファイルは前の中身のまま', async (t) => {
  const cases: { name: string; io: Partial<LocalStateIo>; code: string }[] = [
    { name: '名前の変更が EXDEV で失敗', io: fakeIo({ renameCode: 'EXDEV' }), code: 'EXDEV' },
    { name: '名前の変更が毎回 EPERM で失敗（やり直しても失敗し続ける）', io: fakeIo({ renameCode: 'EPERM' }), code: 'EPERM' },
    { name: '一時ファイルへの書き込みが ENOSPC で失敗', io: fakeIo({ writeFails: true }), code: 'ENOSPC' },
  ];
  for (const c of cases) {
    await t.test(c.name, (st) => {
      const dir = tempDir(st);
      const path = join(dir, 'loop.json');
      writeFileSync(path, stateText({ version: 1, n: 1 }));
      const snap = load(path);
      let r: ReturnType<typeof saveLoopState> | undefined;
      assert.doesNotThrow(() => {
        r = saveLoopState(snap, { version: 1, n: 2 }, { io: c.io });
      });
      assert.equal(r?.ok, false);
      if (r && !r.ok) assert.ok(r.errors.join('\n').includes(c.code), `誤りの文に ${c.code} が無い: ${r.errors.join(' / ')}`);
      assert.deepEqual(tmpLeft(dir), []);
      assert.deepEqual(lockLeft(dir), []);
      assert.equal(readFileSync(path, 'utf8'), stateText({ version: 1, n: 1 }));
    });
  }
});

// --- 読み込み ---

test('loadLoopState：ファイルが無ければ state も text も null', (t) => {
  const dir = tempDir(t);
  const snap = load(join(dir, 'missing.json'));
  assert.equal(snap.state, null);
  assert.equal(snap.text, null);
});

test('loadLoopState：壊れた JSON・形の誤りは「上書きしません」と parse の誤りと渡した添え書きを付けて ok: false', async (t) => {
  const HINT = '直すか消せば、次の回から初回として回ります';
  const cases: { name: string; text: string; detail: string }[] = [
    { name: '壊れた JSON', text: '{ not json', detail: 'JSON として読めません' },
    { name: '形の誤り', text: '{"version":2}', detail: '形が違います' },
  ];
  for (const c of cases) {
    await t.test(c.name, (st) => {
      const dir = tempDir(st);
      const path = join(dir, 'loop.json');
      writeFileSync(path, c.text);
      const r = loadLoopState<S>(path, parseS, HINT);
      assert.equal(r.ok, false);
      if (!r.ok) {
        const msg = r.errors.join('\n');
        for (const w of ['上書きしません', path, c.detail, HINT]) assert.ok(msg.includes(w), `誤りの文に「${w}」が無い: ${msg}`);
      }
      assert.equal(readFileSync(path, 'utf8'), c.text);
    });
  }
});

// --- 引数 ---

test('parseLoopArgs：位置引数と --state・--drafts を分ける', () => {
  const r = parseLoopArgs(['a', '--state', 's.json', 'b', '--drafts', 'd.json'], ['--state', '--drafts']);
  assert.ok(r.ok, `誤り: ${r.ok ? '' : r.errors.join(' / ')}`);
  assert.deepEqual(r.positional, ['a', 'b']);
  assert.deepEqual(r.values, { '--state': 's.json', '--drafts': 'd.json' });
});

test('parseLoopArgs：値が無い・2回ある・知らない -- 引数は誤り', () => {
  const cases: { args: string[]; words: string[] }[] = [
    { args: ['--state'], words: ['--state', '値がありません'] },
    { args: ['--drafts', 'a', '--drafts', 'b'], words: ['--drafts', '2回あります'] },
    { args: ['--nope'], words: ['知らない引数です', '--nope'] },
  ];
  for (const c of cases) {
    const r = parseLoopArgs(c.args, ['--state', '--drafts']);
    assert.equal(r.ok, false, `${c.args.join(' ')} が誤りにならない`);
    if (!r.ok) for (const w of c.words) assert.ok(r.errors.join('\n').includes(w), `${c.args.join(' ')}: 誤りの文に「${w}」が無い: ${r.errors.join(' / ')}`);
  }
});
