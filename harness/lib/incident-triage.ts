/**
 * セッションの問題の記録（incident）の振り分けを Jev に問い、セッションの振り分けと並べて残す shadow（Issue #498）。
 * 振り分けの結果は今までどおりセッションが決める。Jev の答えは <セッションID>.triage.jsonl（incident の記録と同じディレクトリ、0600）に残すだけで、
 * ゲートの判断にも振り分けの結果にも使わない。一致の割合（triageStats）を人が見て、enforce にするかを決める。
 * 材料は記録の kind・what・workaround だけ（target・at・セッション ID・source は渡さない）で、各文字列にもう一度 maskSecrets をかける。
 * 鍵（JEV_API_KEY）が無い・jev.mode=off・材料が大きいときは問わずに skipped で残す。環境の値は呼び出し側が渡す（process.env を直接読まない）。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessConfig } from './config.ts';
import { incidentDir, isValidSession, maskSecrets, type Incident } from './incident.ts';
import { askJev, measureRequest } from './jev.ts';

type Env = Record<string, string | undefined>;

/** 振り分けの3つ：ハーネスの不具合・手順の抜け／このパソコンの環境／一度きりのミス */
export const INCIDENT_TRIAGE_CLASSES = ['harness', 'environment', 'once'] as const;
export type IncidentTriageClass = (typeof INCIDENT_TRIAGE_CLASSES)[number];

/** 問いの版。問い・criteria を変えたら上げる（古い版の記録は使い回さない） */
export const INCIDENT_TRIAGE_QUESTION_SET = 1;

export function isIncidentTriageClass(v: unknown): v is IncidentTriageClass {
  return typeof v === 'string' && (INCIDENT_TRIAGE_CLASSES as readonly string[]).includes(v);
}

/** 記録の1行 */
export interface IncidentTriageRecord {
  version: 1;
  incidentId: number;
  at: string;
  session: IncidentTriageClass;
  jev: { status: 'ok'; model: string; probabilities: Record<IncidentTriageClass, number>; top: IncidentTriageClass } | { status: 'skipped' | 'error'; detail: string };
  agree: boolean | null;
  questionSet: number;
  size: { chars: number; jaRatio: number } | null;
}

const INSTRUCTIONS =
  '`incident` is a problem that an AI coding session ran into while following a development harness (a set of rules, scripts, and gates around GitHub issues and pull requests). `kind` is the category the session recorded, `what` is what happened, and `workaround` is what the session did instead (may be empty). Which kind of cause does this problem have? If you cannot tell, choose harness.';

const CRITERIA: Record<IncidentTriageClass, string> = {
  harness:
    'The harness itself is wrong or incomplete: a script, gate, or check behaved incorrectly, a documented step is missing or contradicts another rule, or the session had to invent a step the rules did not describe. Also choose this when the cause cannot be read from the text.',
  environment:
    'The cause is the local machine or account the session ran on, not the harness: a tool version, an installation, authentication or a login, a file path, network access, or operating-system behavior.',
  once: 'A one-time mistake by the session or a person that the existing rules already cover: the rules were clear and correct, but were not followed this time, and nothing needs to change in the harness or the machine.',
};

/** Jev に渡す材料。kind・what・workaround だけで、各文字列に秘密に見える部分の置き換えをかける（workaround が無ければ空文字） */
export function incidentTriageMaterial(i: Incident): { kind: string; what: string; workaround: string } {
  return { kind: maskSecrets(i.kind), what: maskSecrets(i.what), workaround: maskSecrets(i.workaround ?? '') };
}

export function buildIncidentTriageRequest(config: HarnessConfig, i: Incident) {
  return {
    model: config.jev.model,
    state: { incident: incidentTriageMaterial(i) },
    questions: {
      incident_class: { type: 'choice' as const, instructions: INSTRUCTIONS, criteria: CRITERIA },
    },
  };
}

/** Jev の答えから3つの確率と一番の種類を読む（同じなら INCIDENT_TRIAGE_CLASSES の前のほう）。読めなければ null */
function readAnswer(answers: Record<string, { probabilities?: Record<string, number> } | undefined>): { probabilities: Record<IncidentTriageClass, number>; top: IncidentTriageClass } | null {
  const p = answers.incident_class?.probabilities;
  if (!p) return null;
  const probabilities = {} as Record<IncidentTriageClass, number>;
  for (const c of INCIDENT_TRIAGE_CLASSES) {
    const v = p[c];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    probabilities[c] = v;
  }
  let top: IncidentTriageClass = INCIDENT_TRIAGE_CLASSES[0];
  for (const c of INCIDENT_TRIAGE_CLASSES) if (probabilities[c] > probabilities[top]) top = c;
  return { probabilities, top };
}

/**
 * 1件を Jev に問い、セッションの振り分けと並べて記録に足して、その記録を返す。Jev の失敗・鍵なし・off・材料が大きすぎるときも記録は残す（問わなければ skipped）。
 * ask は差し替えられる（routeModel と同じ）。
 */
export async function triageIncident(
  config: HarnessConfig,
  apiKey: string | undefined,
  session: string,
  incident: Incident,
  as: IncidentTriageClass,
  env: Env,
  ask: typeof askJev = askJev,
  now: Date = new Date(),
): Promise<IncidentTriageRecord> {
  const request = buildIncidentTriageRequest(config, incident);
  const size = measureRequest(request);
  const base = { version: 1 as const, incidentId: incident.id, at: now.toISOString(), session: as, questionSet: INCIDENT_TRIAGE_QUESTION_SET, size };
  const settle = (jev: IncidentTriageRecord['jev']): IncidentTriageRecord => {
    const record: IncidentTriageRecord = { ...base, jev, agree: jev.status === 'ok' ? jev.top === as : null };
    appendTriage(session, record, env);
    return record;
  };
  if (config.jev.mode === 'off') return settle({ status: 'skipped', detail: 'jev.mode=off' });
  if (!apiKey) return settle({ status: 'skipped', detail: 'JEV_API_KEY が未設定' });
  if (size.chars > config.jev.maxDiffChars) return settle({ status: 'skipped', detail: `材料が大きすぎます（${size.chars} 文字 > ${config.jev.maxDiffChars}）` });
  try {
    const res = await ask(apiKey, request);
    if (res.status === 'error') return settle({ status: 'error', detail: res.detail });
    const read = readAnswer(res.answers);
    if (!read) return settle({ status: 'error', detail: '答えに incident_class の確率がありません' });
    return settle({ status: 'ok', model: res.model, probabilities: read.probabilities, top: read.top });
  } catch (e) {
    return settle({ status: 'error', detail: maskSecrets(String(e)).slice(0, 300) });
  }
}

/** 振り分けの記録のファイル。セッション ID がファイル名に使えない形なら Error */
export function triageFile(session: string, env: Env): string {
  if (!isValidSession(session)) throw new Error(`セッション ID は英数字と - _ だけ使えます: ${session}`);
  return join(incidentDir(env), `${session}.triage.jsonl`);
}

/** 1行足す。ディレクトリは 0700、ファイルは 0600 */
export function appendTriage(session: string, record: IncidentTriageRecord, env: Env): void {
  const file = triageFile(session, env);
  const dir = incidentDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  chmodSync(file, 0o600);
}

/** 記録を読む。ファイルが無ければ空。壊れた行・形の違う行は飛ばす */
export function readTriage(session: string, env: Env): IncidentTriageRecord[] {
  const file = triageFile(session, env);
  if (!existsSync(file)) return [];
  const out: IncidentTriageRecord[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line) as Partial<IncidentTriageRecord>;
      if (typeof v.incidentId === 'number' && typeof v.at === 'string' && isIncidentTriageClass(v.session) && v.jev && typeof v.jev === 'object' && ['ok', 'skipped', 'error'].includes(v.jev.status)) out.push(v as IncidentTriageRecord);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out;
}

/** 振り分けの記録があるセッション ID を、更新の新しい順に（*.triage.jsonl だけ） */
export function listTriageSessions(env: Env): string[] {
  const dir = incidentDir(env);
  if (!existsSync(dir)) return [];
  const suffix = '.triage.jsonl';
  return readdirSync(dir)
    .filter((f) => f.endsWith(suffix) && isValidSession(f.slice(0, -suffix.length)))
    .map((f) => ({ id: f.slice(0, -suffix.length), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

export interface TriageStats {
  total: number;
  ok: number;
  agree: number;
  skipped: number;
  error: number;
  /** 「セッションの振り分け→Jev の一番の種類」ごとの件数（ok のものだけ） */
  pairs: Record<string, number>;
}

/** 集計。(セッション, incident の id) ごとに最後の行だけを数える（id はセッションごとに1から振られる） */
export function triageStats(rows: { session: string; record: IncidentTriageRecord }[]): TriageStats {
  const last = new Map<string, IncidentTriageRecord>();
  for (const { session, record } of rows) last.set(`${session}\u0000${record.incidentId}`, record);
  const out: TriageStats = { total: last.size, ok: 0, agree: 0, skipped: 0, error: 0, pairs: {} };
  for (const r of last.values()) {
    if (r.jev.status === 'ok') {
      out.ok++;
      if (r.session === r.jev.top) out.agree++;
      const key = `${r.session}→${r.jev.top}`;
      out.pairs[key] = (out.pairs[key] ?? 0) + 1;
    } else out[r.jev.status]++;
  }
  return out;
}
