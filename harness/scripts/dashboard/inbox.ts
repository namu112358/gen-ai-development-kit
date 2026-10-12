/**
 * 手元のダッシュボードの気づきの受け箱（Issue #817）。置き場所は git の共通ディレクトリの下の agent-harness/inbox/。GitHub には書かない。
 *
 *   notes/<id>.json  ダッシュボードの「気づきを送る」欄から送った文（1件1ファイル）
 *   read/<id>        intel が読んだ印（空のファイル）。未読は notes/ にあって read/ に無いもの
 *
 * 書く側（ダッシュボード）と印を付ける側（intel）が別のファイルを書くので、同じファイルを取り合わない。
 * intel が使う CLI：
 *
 *   node harness/scripts/dashboard/inbox.ts list
 *   node harness/scripts/dashboard/inbox.ts mark-read <id>...
 *   node harness/scripts/dashboard/inbox.ts wait [--timeout-ms N]
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir, harnessStateDir, writeLocalFileOnce } from '../../lib/local-state.ts';

export const NOTE_ID_PATTERN = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;
export const MAX_NOTE_CHARS = 4000;
export const WAIT_DEFAULT_TIMEOUT_MS = 1_800_000;
const WAIT_DEFAULT_INTERVAL_MS = 2000;

export interface InboxNote {
  version: 1;
  id: string;
  at: string;
  source: 'dashboard';
  text: string;
}

/** 受け箱を置くディレクトリ（共通ディレクトリの下の agent-harness/inbox） */
export function inboxDir(commonDir: string): string {
  return join(harnessStateDir(commonDir), 'inbox');
}

/** <UTC の時刻 yyyyMMddTHHmmssSSSZ>-<16進8桁>。時刻で並ぶので id の昇順が古い順 */
export function newNoteId(now: Date, rand: () => string = () => randomBytes(4).toString('hex')): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  return `${stamp}-${rand()}`;
}

function parseNote(raw: string, id: string): InboxNote | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || o.id !== id || typeof o.at !== 'string' || o.source !== 'dashboard' || typeof o.text !== 'string') return null;
  return { version: 1, id, at: o.at, source: 'dashboard', text: o.text };
}

export class Inbox {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(dir: string, opts: { now?: () => Date } = {}) {
    this.dir = dir;
    this.now = opts.now ?? (() => new Date());
  }

  private notePath(id: string): string {
    return join(this.dir, 'notes', `${id}.json`);
  }

  private readPath(id: string): string {
    return join(this.dir, 'read', id);
  }

  /** text の前後の空白を除いて保存する。空・MAX_NOTE_CHARS 超えは Error。改行はそのまま残す */
  add(text: string): InboxNote {
    const trimmed = text.trim();
    if (trimmed === '') throw new Error('text が空です');
    if (trimmed.length > MAX_NOTE_CHARS) throw new Error(`text は ${MAX_NOTE_CHARS} 文字までです`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const at = this.now();
      const note: InboxNote = { version: 1, id: newNoteId(at), at: at.toISOString(), source: 'dashboard', text: trimmed };
      if (writeLocalFileOnce(this.notePath(note.id), `${JSON.stringify(note, null, 2)}\n`)) return note;
    }
    throw new Error('気づきの id が重なりました。もう一度送ってください');
  }

  private noteIds(): string[] {
    const dir = join(this.dir, 'notes');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => n.endsWith('.json') && NOTE_ID_PATTERN.test(n.slice(0, -'.json'.length)))
      .map((n) => n.slice(0, -'.json'.length))
      .sort();
  }

  private unreadIds(): string[] {
    return this.noteIds().filter((id) => !existsSync(this.readPath(id)));
  }

  /** 未読を id の昇順（古い順）で。読めない JSON は飛ばす */
  list(): InboxNote[] {
    const out: InboxNote[] = [];
    for (const id of this.unreadIds()) {
      try {
        const note = parseNote(readFileSync(this.notePath(id), 'utf8'), id);
        if (note) out.push(note);
      } catch {
        // 書きかけ・消えたファイルは飛ばす
      }
    }
    return out;
  }

  unread(): number {
    return this.unreadIds().length;
  }

  /** 全部の id が形に合い notes/ に在るときだけ、読んだ印を付ける。1つでも合わなければ何も書かない */
  markRead(ids: string[]): { ok: true } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    for (const id of ids) {
      if (!NOTE_ID_PATTERN.test(id)) errors.push(`${id}: id の形が合いません`);
      else if (!existsSync(this.notePath(id))) errors.push(`${id}: 気づきがありません`);
    }
    if (errors.length > 0) return { ok: false, errors };
    for (const id of ids) writeLocalFileOnce(this.readPath(id), '');
    return { ok: true };
  }
}

export type WaitResult = { result: 'unread'; unread: number } | { result: 'timeout'; unread: 0 };

/** 始めに1回数え、以後 intervalMs ごとに数える。未読が1件以上なら unread、timeoutMs が過ぎたら timeout */
export async function waitForUnread(inbox: Inbox, opts: { timeoutMs: number; intervalMs?: number }): Promise<WaitResult> {
  const interval = opts.intervalMs ?? WAIT_DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const n = inbox.unread();
    if (n > 0) return { result: 'unread', unread: n };
    const left = deadline - Date.now();
    if (left <= 0) return { result: 'timeout', unread: 0 };
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(interval, left)));
  }
}

class UsageError extends Error {}

function parseTimeout(args: string[]): number {
  const i = args.indexOf('--timeout-ms');
  if (i === -1) return WAIT_DEFAULT_TIMEOUT_MS;
  const raw = args[i + 1] ?? '';
  const v = Number(raw);
  if (raw === '' || !Number.isFinite(v) || v < 0) throw new UsageError('--timeout-ms は 0 以上の数で指定してください');
  return v;
}

/** CLI。終了コードを返す（0 成功、1 使い方・id の誤り・共通ディレクトリが取れない） */
export async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command !== 'list' && command !== 'mark-read' && command !== 'wait') {
      throw new UsageError('使い方: inbox.ts list | mark-read <id>... | wait [--timeout-ms N]');
    }
    const common = gitCommonDir();
    if (common === null) throw new UsageError('git の共通ディレクトリが取れません（git のリポジトリの中で実行してください）');
    const inbox = new Inbox(inboxDir(common));
    if (command === 'list') {
      console.log(JSON.stringify(inbox.list().map((n) => ({ id: n.id, at: n.at, text: n.text })), null, 2));
      return 0;
    }
    if (command === 'mark-read') {
      if (rest.length === 0) throw new UsageError('mark-read には id を1つ以上渡してください');
      const r = inbox.markRead(rest);
      if (!r.ok) throw new UsageError(r.errors.join('\n'));
      return 0;
    }
    console.log(JSON.stringify(await waitForUnread(inbox, { timeoutMs: parseTimeout(rest) })));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(e.message);
      process.exit(2);
    },
  );
}
