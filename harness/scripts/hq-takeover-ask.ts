/**
 * Issue #771：止まった宣言・担当のいない PR の引き継ぎの問いを、hq が 24 時間（HQ_TAKEOVER_DEFAULTS。設定では変えない）に1回まとめて聞く判定と記録。
 *
 *   node harness/scripts/hq-takeover-ask.ts check <found.json> [--common-dir <dir>]（見つけたもの TakeoverItem[] から判定を JSON で出す。記録は書かない）
 *   node harness/scripts/hq-takeover-ask.ts record <answer.json> [--common-dir <dir>]（{ declined: {key,state}[], taken: string[] } で記録を更新する）
 *
 * - 記録は git の共通ディレクトリの下の agent-harness/hq/hq-takeover-ask.json（hq の控え hq-fleets.json とは別。ledger-save で消えない）。
 * - 見送った key は state が同じ間は聞き直さない。判定・記録の更新は純粋関数で、CLI は import.meta.main の中だけで動く。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeLocalJson } from '../lib/local-state.ts';
import { gitCommonDir, hqStateDir } from './hq-state.ts';

export const HQ_TAKEOVER_DEFAULTS = { takeoverAskHours: 24 } as const;

export interface TakeoverItem { key: string; state: string; line: string }
export interface TakeoverDeclined { key: string; state: string }
export interface TakeoverRecord { version: 1; lastAskedAt: string | null; declined: TakeoverDeclined[] }
export interface TakeoverDecision { due: boolean; ask: TakeoverItem[]; held: number; skippedDeclined: number; nextAskAt: string | null }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ms = (iso: string | null | undefined): number | null => {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function takeoverAskDecision(a: { found: TakeoverItem[]; record: TakeoverRecord | null; now: number; hours: number }): TakeoverDecision {
  const seen = new Set<string>();
  const declined = new Map((a.record?.declined ?? []).map((d) => [d.key, d.state]));
  const ask: TakeoverItem[] = [];
  let skippedDeclined = 0;
  for (const it of a.found) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    if (declined.get(it.key) === it.state) skippedDeclined++;
    else ask.push(it);
  }
  const last = ms(a.record?.lastAskedAt);
  const intervalMs = a.hours * 3_600_000;
  const due = ask.length > 0 && (last === null || a.now - last >= intervalMs);
  return { due, ask, held: ask.length, skippedDeclined, nextAskAt: last === null ? null : new Date(last + intervalMs).toISOString() };
}

/** 答えを記録に反映する。lastAskedAt は now に進め、見送りは key ごとに置き換え、引き継いだ key は見送りから外す */
export function recordTakeoverAnswer(record: TakeoverRecord | null, a: { now: number; declined: TakeoverDeclined[]; taken: string[] }): TakeoverRecord {
  const map = new Map((record?.declined ?? []).map((d) => [d.key, d.state]));
  for (const d of a.declined) map.set(d.key, d.state);
  for (const k of a.taken) map.delete(k);
  return { version: 1, lastAskedAt: new Date(a.now).toISOString(), declined: [...map].map(([key, state]) => ({ key, state })) };
}

export function takeoverPath(commonDir: string): string {
  return join(hqStateDir(commonDir), 'hq-takeover-ask.json');
}

/** 読めない・version が違うときは null（記録なし） */
export function parseTakeoverRecord(v: unknown): TakeoverRecord | null {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.declined)) return null;
  if (v.lastAskedAt !== null && typeof v.lastAskedAt !== 'string') return null;
  const declined: TakeoverDeclined[] = [];
  for (const d of v.declined) {
    if (!isObj(d) || typeof d.key !== 'string' || typeof d.state !== 'string') return null;
    declined.push({ key: d.key, state: d.state });
  }
  return { version: 1, lastAskedAt: v.lastAskedAt, declined };
}

function readRecord(commonDir: string): TakeoverRecord | null {
  const path = takeoverPath(commonDir);
  if (!existsSync(path)) return null;
  try { return parseTakeoverRecord(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseFound(v: unknown): TakeoverItem[] {
  if (!Array.isArray(v)) throw new Error('found は TakeoverItem の配列で書いてください');
  return v.map((x) => {
    if (!isObj(x) || typeof x.key !== 'string' || typeof x.state !== 'string' || typeof x.line !== 'string') throw new Error('found の要素は key・state・line を文字列で書いてください');
    return { key: x.key, state: x.state, line: x.line };
  });
}

function parseAnswer(v: unknown): { declined: TakeoverDeclined[]; taken: string[] } {
  if (!isObj(v) || !Array.isArray(v.declined) || !Array.isArray(v.taken)) throw new Error('answer は { declined: {key,state}[], taken: string[] } で書いてください');
  const declined = v.declined.map((d) => {
    if (!isObj(d) || typeof d.key !== 'string' || typeof d.state !== 'string') throw new Error('declined の要素は key・state を文字列で書いてください');
    return { key: d.key, state: d.state };
  });
  const taken = v.taken.map((k) => {
    if (typeof k !== 'string') throw new Error('taken は key の文字列の配列で書いてください');
    return k;
  });
  return { declined, taken };
}

function main(argv: string[]): void {
  const usage = '使い方：hq-takeover-ask.ts (check <found.json> | record <answer.json>) [--common-dir <dir>]';
  const positional: string[] = [];
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--common-dir' && argv[i + 1]) { dir = argv[i + 1] as string; i++; }
    else positional.push(argv[i] as string);
  }
  const [cmd, file] = positional;
  if ((cmd !== 'check' && cmd !== 'record') || !file || positional.length !== 2) throw new Error(usage);
  const commonDir = dir ?? gitCommonDir(process.cwd());
  if (!commonDir) throw new Error('git の共通ディレクトリが見つかりません');
  const { takeoverAskHours } = HQ_TAKEOVER_DEFAULTS;
  if (cmd === 'check') {
    const decision = takeoverAskDecision({ found: parseFound(readJsonFile(file)), record: readRecord(commonDir), now: Date.now(), hours: takeoverAskHours });
    console.log(JSON.stringify(decision, null, 2));
    return;
  }
  const answer = parseAnswer(readJsonFile(file));
  const next = recordTakeoverAnswer(readRecord(commonDir), { now: Date.now(), ...answer });
  writeLocalJson(takeoverPath(commonDir), next);
  console.log(JSON.stringify(next));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
