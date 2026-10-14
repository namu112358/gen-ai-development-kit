// Issue #653：手元の状態のファイルの書き込み（harness/lib/local-state.ts）。名前の変更のやり直しと、
// 失敗したときに一時ファイルを残さず元のファイルを前の中身のまま残すこと（io の差し替えで失敗を起こす）。
// 書く中身の字下げ・writeLocalFileOnce の2回目が false なことは既存のテスト（stage-file・hq-stall・harness-drift・hq-state）に任せる。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RENAME_RETRY_DELAYS_MS, RETRYABLE_RENAME_CODES, writeLocalFile, writeLocalFileOnce, type LocalStateIo } from '../lib/local-state.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const codeError = (code: string): Error => Object.assign(new Error(`fake ${code}`), { code });
const tmpLeft = (dir: string): string[] => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

// renameSync は最初の fails 回だけ code 付きのエラーを投げ、その後は本物を呼ぶ。sleep は待たずに ms を控える。
function fakeIo(opts: { renameFails?: number; renameCode?: string; writeFails?: boolean }) {
  const calls = { rename: 0, sleeps: [] as number[] };
  const io: Partial<LocalStateIo> = {
    renameSync: ((from: string, to: string) => {
      calls.rename++;
      if (calls.rename <= (opts.renameFails ?? 0)) throw codeError(opts.renameCode ?? 'EPERM');
      renameSync(from, to);
    }) as LocalStateIo['renameSync'],
    sleep: (ms: number) => { calls.sleeps.push(ms); },
  };
  if (opts.writeFails) {
    io.writeFileSync = ((p: string, data: string) => {
      writeFileSync(p, data.slice(0, 1)); // 書きかけを残してから失敗する
      throw codeError('ENOSPC');
    }) as LocalStateIo['writeFileSync'];
  }
  return { io, calls };
}

test('定数：やり直しの待ちは 20・40・80・160 ms、やり直す code は EPERM・EBUSY・EACCES', () => {
  assert.deepEqual([...RENAME_RETRY_DELAYS_MS], [20, 40, 80, 160]);
  assert.deepEqual([...RETRYABLE_RENAME_CODES].sort(), ['EACCES', 'EBUSY', 'EPERM']);
});

test('writeLocalFile：名前の変更が1回 EPERM で失敗しても、やり直して書け、一時ファイルが残らない', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'state.json');
  writeFileSync(path, 'old');
  const { io, calls } = fakeIo({ renameFails: 1, renameCode: 'EPERM' });
  writeLocalFile(path, 'new', { io });
  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.deepEqual(tmpLeft(dir), []);
  assert.equal(calls.rename, 2);
  assert.deepEqual(calls.sleeps, [20]);
});

const FAILURES: { name: string; fake: Parameters<typeof fakeIo>[0]; code: string; renames: number; sleeps: number[] }[] = [
  { name: '毎回 EBUSY（やり直しても失敗し続ける）', fake: { renameFails: Infinity, renameCode: 'EBUSY' }, code: 'EBUSY', renames: 5, sleeps: [20, 40, 80, 160] },
  { name: 'EXDEV（やり直さない code）', fake: { renameFails: Infinity, renameCode: 'EXDEV' }, code: 'EXDEV', renames: 1, sleeps: [] },
  { name: 'ENOENT（やり直さない code）', fake: { renameFails: Infinity, renameCode: 'ENOENT' }, code: 'ENOENT', renames: 1, sleeps: [] },
  { name: '一時ファイルへの書き込みの失敗', fake: { writeFails: true }, code: 'ENOSPC', renames: 0, sleeps: [] },
];

test('writeLocalFile：失敗したときは一時ファイルを残さず、パスと code を入れたエラーになり、元のファイルは前の中身のまま', async (t) => {
  for (const c of FAILURES) {
    await t.test(c.name, (st) => {
      const dir = tempDir(st);
      const path = join(dir, 'state.json');
      writeFileSync(path, 'old');
      const { io, calls } = fakeIo(c.fake);
      assert.throws(() => writeLocalFile(path, 'new', { io }), (e: Error) => {
        assert.ok(e.message.includes(path), `メッセージにパスが無い: ${e.message}`);
        assert.ok(e.message.includes(c.code), `メッセージに ${c.code} が無い: ${e.message}`);
        assert.ok(e.cause instanceof Error, 'cause に元のエラーが無い');
        return true;
      });
      assert.deepEqual(tmpLeft(dir), []);
      assert.equal(readFileSync(path, 'utf8'), 'old');
      assert.equal(calls.rename, c.renames);
      assert.deepEqual(calls.sleeps, c.sleeps);
    });
  }
});

test('writeLocalFileOnce：書きかけで失敗したら作りかけのファイルを消して throw する（ディレクトリが無くても作る）', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'sub', 'loaded.json');
  const { io } = fakeIo({ writeFails: true });
  assert.throws(() => writeLocalFileOnce(path, 'new', { io }));
  assert.equal(existsSync(path), false);
  assert.equal(writeLocalFileOnce(path, 'first'), true);
  assert.equal(readFileSync(path, 'utf8'), 'first');
});
