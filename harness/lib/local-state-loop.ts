/**
 * 見直しの loop（test-prune・qa-retro・patrol）の状態のファイルの読み書きの補助（Issue #414）。
 * 読み込みは本文ごと控え（snapshot）、書き戻すときは「読んだときの本文」と「今の本文」を比べて、違えば（ほかのセッションが書いた）上書きせずに誤りで止める。
 * 比べてから名前を変えるまでの間だけ鍵のファイル `<状態のファイル>.lock` を作る（既にあれば書いている途中として止まる。残っていればプロセスが落ちた跡で、消してよい）。
 * 書き込みは local-state.ts の writeLocalJson（一時ファイル経由。失敗したら一時ファイルを消す）を通し、失敗は例外にせず Result の誤りで返す。
 * 3つのスクリプトの引数（位置引数と値を取る --state・--drafts）・既定のパス・誤りの出し方もここにまとめる。
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gitCommonDir, harnessStateDir, writeLocalFile, writeLocalFileOnce, writeLocalJson, type LocalStateIo } from './local-state.ts';

export type LoopResult<T> = ({ ok: true } & T) | { ok: false; errors: string[] };

export interface LoopStateSnapshot<T> {
  path: string;
  /** 読んだときの本文（ファイルが無ければ null）。書き戻すときの比べに使う */
  text: string | null;
  state: T | null;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 誤りを出して終わる（終了コード 1） */
export function exitWithErrors(errors: string[]): never {
  console.error(['誤り:', ...errors.map((e) => `- ${e}`)].join('\n'));
  process.exit(1);
}

/** ファイルの本文。無ければ null、ほかの理由で読めなければ Error を投げる */
export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${path} を読めません: ${message(e)}`, { cause: e });
  }
}

/** JSON のファイルを読む。what は誤りの文に入れる名前 */
export function readJsonFile(path: string, what: string): LoopResult<{ value: unknown }> {
  let text: string | null;
  try {
    text = readText(path);
  } catch (e) {
    return { ok: false, errors: [message(e)] };
  }
  if (text === null) return { ok: false, errors: [`${what}のファイルがありません: ${path}`] };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, errors: [`${what}のファイルが JSON として読めません: ${message(e)}`] };
  }
}

/** 状態のファイルを読んで parse する。読めない・形が違うときは「上書きしません」で誤りにする（hint は括弧で添える） */
export function loadLoopState<T>(
  path: string,
  parse: (text: string | null) => LoopResult<{ state: T | null }>,
  hint?: string,
): LoopResult<{ snapshot: LoopStateSnapshot<T> }> {
  let text: string | null;
  try {
    text = readText(path);
  } catch (e) {
    return { ok: false, errors: [message(e)] };
  }
  const parsed = parse(text);
  if (!parsed.ok) {
    const suffix = hint === undefined ? '' : `（${hint}）`;
    return { ok: false, errors: [`状態のファイル（${path}）を読めません。上書きしません${suffix}`, ...parsed.errors] };
  }
  return { ok: true, snapshot: { path, text, state: parsed.state } };
}

/**
 * 読んだときから変わっていなければ、extra のファイル・状態の順で書く。変わっていた・鍵が既にある・書けなかったときは ok: false（鍵は自分が作ったものだけ消す）。
 * io は状態の書き込み（writeLocalJson）にだけ渡す。
 */
export function saveLoopState(
  snapshot: { path: string; text: string | null },
  next: unknown,
  opts: { io?: Partial<LocalStateIo>; extra?: { path: string; content: string }[] } = {},
): LoopResult<{}> {
  const { path } = snapshot;
  const lock = `${path}.lock`;
  try {
    if (!writeLocalFileOnce(lock, `${process.pid}\n`)) {
      return {
        ok: false,
        errors: [`状態のファイル（${path}）はほかのセッションが書いている途中です（鍵 ${lock}）。上書きしません。少し待ってもう一度流してください。鍵が残ったままなら、落ちたプロセスの跡なので消してよい`],
      };
    }
  } catch (e) {
    return { ok: false, errors: [message(e)] };
  }
  let extraWritten = false;
  try {
    if (readText(path) !== snapshot.text) {
      return {
        ok: false,
        errors: [`状態のファイル（${path}）は読んだ後にほかのセッションが書きました。上書きしません。もう一度コマンドを流すと、新しい中身を読み直してやり直します`],
      };
    }
    for (const f of opts.extra ?? []) {
      extraWritten = true;
      writeLocalFile(f.path, f.content);
    }
    writeLocalJson(path, next, { io: opts.io });
    return { ok: true };
  } catch (e) {
    const note = extraWritten && opts.extra?.length ? ['観測の写し（extra）は書かれた可能性があります。もう一度コマンドを流せば揃います'] : [];
    return { ok: false, errors: [message(e), ...note] };
  } finally {
    rmSync(lock, { force: true });
  }
}

/** 位置引数と、値を取る引数（valueFlags。例 --state・--drafts）を分ける */
export function parseLoopArgs(args: string[], valueFlags: readonly string[]): LoopResult<{ positional: string[]; values: Record<string, string> }> {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) {
      const v = args[++i];
      if (v === undefined) return { ok: false, errors: [`${a} の値がありません`] };
      if (values[a] !== undefined) return { ok: false, errors: [`${a} が2回あります`] };
      values[a] = v;
    } else if (a.startsWith('--')) return { ok: false, errors: [`知らない引数です: ${a}`] };
    else positional.push(a);
  }
  return { ok: true, positional, values };
}

/** 状態のファイルの既定のパス（git の共通ディレクトリの下の agent-harness/<fileName>） */
export function loopStatePath(root: string, fileName: string): LoopResult<{ path: string }> {
  const commonDir = gitCommonDir(root);
  if (commonDir === null) return { ok: false, errors: [`git の共通ディレクトリが分かりません: ${root}`] };
  return { ok: true, path: join(harnessStateDir(commonDir), fileName) };
}
