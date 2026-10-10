/**
 * 手元の状態のファイル（git の共通ディレクトリの下の agent-harness/ と panes のスナップショット）の場所の決め方と一時ファイル経由の書き込み（Issue #653）。
 * 段階・見張り・loaded・hq の控え・panes の書き込みと、共通ディレクトリの探し方はここを通す（置き場所と書く中身の形は呼び出し元が決める）。
 * 書き込みは `<path>.<pid>.tmp` に書いてから名前を変える。名前の変更が EPERM・EBUSY・EACCES（Windows でほかのプロセスがファイルを開いているとき）で
 * 失敗したら 20・40・80・160 ms 待って最大4回やり直し、それでも失敗したとき・ほかの code・一時ファイルへの書き込みの失敗では
 * 一時ファイルを消してエラーにする（元のファイルは前の中身のまま）。ファイルの操作は引数 io で差し替えられる。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TRANSCRIPT_SESSION_ID } from './session.ts';

/** git の共通ディレクトリ（worktree からも本体と同じ）。git の外・取れなければ null */
export function gitCommonDir(cwd: string = process.cwd()): string | null {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  const out = r.status === 0 ? String(r.stdout ?? '').trim() : '';
  return out === '' ? null : out;
}

/** 手元の状態のファイルを置くディレクトリ（共通ディレクトリの下の agent-harness） */
export function harnessStateDir(commonDir: string): string {
  return join(commonDir, 'agent-harness');
}

export type SessionFileKind = 'loaded' | 'watch' | 'stage';

/** セッションごとの記録のパス。ID が記録のファイル名に使える形（TRANSCRIPT_SESSION_ID）でなければ null（書かない・読まない） */
export function sessionFilePath(commonDir: string, kind: SessionFileKind, session: string | null): string | null {
  if (!session || !TRANSCRIPT_SESSION_ID.test(session)) return null;
  return join(harnessStateDir(commonDir), kind, `${session}.json`);
}

export interface LocalStateIo {
  mkdirSync: typeof mkdirSync;
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  rmSync: typeof rmSync;
  sleep(ms: number): void;
}

/** 名前の変更をやり直すときの待ち（ms）。長さがやり直しの最大回数 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80, 160];
/** 名前の変更をやり直す code */
export const RETRYABLE_RENAME_CODES: readonly string[] = ['EPERM', 'EBUSY', 'EACCES'];

const defaultIo: LocalStateIo = {
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
  sleep: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'unknown';
};

const fail = (action: string, path: string, e: unknown): Error =>
  new Error(`${action}に失敗しました（${codeOf(e)}）: ${path}`, { cause: e });

/** 一時ファイル・作りかけのファイルを消す。消すのに失敗しても元のエラーを優先する */
function removeQuietly(io: LocalStateIo, path: string): void {
  try {
    io.rmSync(path, { force: true });
  } catch {
    // 元のエラーを投げる
  }
}

function ensureDir(io: LocalStateIo, path: string): void {
  try {
    io.mkdirSync(dirname(path), { recursive: true });
  } catch (e) {
    throw fail('ディレクトリの作成', path, e);
  }
}

/** 一時ファイルに書いてから名前を変えて書く（ディレクトリが無ければ作る）。失敗したら一時ファイルを残さずエラーにする */
export function writeLocalFile(path: string, content: string, opts: { io?: Partial<LocalStateIo> } = {}): void {
  const io: LocalStateIo = { ...defaultIo, ...opts.io };
  ensureDir(io, path);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    io.writeFileSync(tmp, content);
  } catch (e) {
    removeQuietly(io, tmp);
    throw fail('一時ファイルへの書き込み', path, e);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      io.renameSync(tmp, path);
      return;
    } catch (e) {
      if (RETRYABLE_RENAME_CODES.includes(codeOf(e)) && attempt < RENAME_RETRY_DELAYS_MS.length) {
        io.sleep(RENAME_RETRY_DELAYS_MS[attempt] ?? 0);
        continue;
      }
      removeQuietly(io, tmp);
      throw fail('名前の変更', path, e);
    }
  }
}

/** 2字下げの JSON と末尾の改行で書く */
export function writeLocalJson(path: string, value: unknown, opts: { io?: Partial<LocalStateIo> } = {}): void {
  writeLocalFile(path, `${JSON.stringify(value, null, 2)}\n`, opts);
}

/** 同じパスが既にあれば書かず false（resume・compact で上書きしない）。書きかけで失敗したら作りかけを消して投げる */
export function writeLocalFileOnce(path: string, content: string, opts: { io?: Partial<LocalStateIo> } = {}): boolean {
  const io: LocalStateIo = { ...defaultIo, ...opts.io };
  ensureDir(io, path);
  try {
    io.writeFileSync(path, content, { flag: 'wx' });
    return true;
  } catch (e) {
    if (codeOf(e) === 'EEXIST') return false;
    removeQuietly(io, path);
    throw fail('書き込み', path, e);
  }
}
