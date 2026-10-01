/**
 * セッションで起きた問題（拒否・人に返す・App の拒否・人の訂正・回避策）の記録（Issue #186）。
 * 記録はリポジトリの外の、セッションごとの JSON Lines に置き、GitHub には書かない。
 * 置き場所の決め方（incidentFile）は、hook（#187）と harness/scripts/agent.ts の incident が共有する。
 * Issue Form の形の下書きと、Routine がダッシュボードに書くコメント本文（```agent-incident）もここで作る。GitHub を呼ばない。
 * 環境の値は呼び出し側が渡す（process.env を直接読まない）。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeMark, renderBlock } from './blocks.ts';
import { TRANSCRIPT_SESSION_ID } from './session.ts';

/** 記録の種類：拒否・人に返す・App の拒否・人の訂正・回避策 */
export const INCIDENT_KINDS = ['deny', 'return-to-human', 'app-reject', 'human-correction', 'workaround'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** 種類の表示名 */
export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  deny: '拒否',
  'return-to-human': '人に返す',
  'app-reject': 'App の拒否',
  'human-correction': '人の訂正',
  workaround: '回避策',
};

/** 記録の1行 */
export interface Incident {
  id: number;
  at: string;
  kind: IncidentKind;
  target?: string;
  what: string;
  workaround?: string;
  source: 'session' | 'hook';
}

export interface IncidentInput {
  kind: string;
  what: string;
  target?: string;
  workaround?: string;
  source?: 'session' | 'hook';
}

type Env = Record<string, string | undefined>;

export function isIncidentKind(v: unknown): v is IncidentKind {
  return typeof v === 'string' && (INCIDENT_KINDS as readonly string[]).includes(v);
}

/** 記録のディレクトリ。AGENT_HARNESS_INCIDENT_DIR があればそれ、無ければホームの下の固定の場所（TMPDIR は使わない） */
export function incidentDir(env: Env): string {
  return env.AGENT_HARNESS_INCIDENT_DIR || join(homedir(), '.agent-harness', 'incidents');
}

/** ファイル名に使える形のセッション ID か（session-env.ts と同じ規則） */
export function isValidSession(session: string): boolean {
  return TRANSCRIPT_SESSION_ID.test(session);
}

/** セッションの記録のファイル。セッション ID がファイル名に使えない形なら Error */
export function incidentFile(session: string, env: Env): string {
  if (!isValidSession(session)) throw new Error(`セッション ID は英数字と - _ だけ使えます: ${session}`);
  return join(incidentDir(env), `${session}.jsonl`);
}

/** 記録を読む。ファイルが無ければ空。壊れた行・形の違う行は飛ばす */
export function readIncidents(session: string, env: Env): Incident[] {
  const file = incidentFile(session, env);
  if (!existsSync(file)) return [];
  const out: Incident[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const v = JSON.parse(line) as Partial<Incident>;
      if (typeof v.id === 'number' && typeof v.what === 'string' && isIncidentKind(v.kind) && typeof v.at === 'string') out.push(v as Incident);
    } catch {
      // 壊れた行は飛ばす
    }
  }
  return out;
}

/** 1件足して、記録したものを返す。ディレクトリは 0700、ファイルは 0600。文字列は秘密に見える部分を置き換えてから書く */
export function appendIncident(session: string, input: IncidentInput, env: Env, now: Date = new Date()): Incident {
  if (!isIncidentKind(input.kind)) throw new Error(`種類は ${INCIDENT_KINDS.join(' / ')} のいずれか: ${input.kind}`);
  if (!input.what || input.what.trim() === '') throw new Error('起きたこと（what）が空です');
  const file = incidentFile(session, env);
  const dir = incidentDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const id = readIncidents(session, env).reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const item: Incident = {
    id,
    at: now.toISOString(),
    kind: input.kind,
    ...(input.target ? { target: maskSecrets(input.target) } : {}),
    what: maskSecrets(input.what),
    ...(input.workaround ? { workaround: maskSecrets(input.workaround) } : {}),
    source: input.source ?? 'session',
  };
  if (!existsSync(file)) writeFileSync(file, '', { mode: 0o600 });
  appendFileSync(file, `${JSON.stringify(item)}\n`);
  chmodSync(file, 0o600);
  return item;
}

/** 記録のディレクトリにあるセッション ID を、更新の新しい順に */
export function listSessions(env: Env): string[] {
  const dir = incidentDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl') && isValidSession(f.slice(0, -'.jsonl'.length)))
    .map((f) => ({ id: f.slice(0, -'.jsonl'.length), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

/** 種類ごとにまとめる（INCIDENT_KINDS の順。項目のある種類だけ） */
export function groupByKind<T extends { kind: IncidentKind }>(items: T[]): Partial<Record<IncidentKind, T[]>> {
  const out: Partial<Record<IncidentKind, T[]>> = {};
  for (const kind of INCIDENT_KINDS) {
    const list = items.filter((i) => i.kind === kind);
    if (list.length > 0) out[kind] = list;
  }
  return out;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\b[0-9a-fA-F]{40,}\b/g,
];

/** 秘密に見える文字列を *** に置き換える（トークンの接頭辞・Bearer・token= などの値・長い base64/hex の連なり） */
export function maskSecrets(text: string): string {
  let s = text.replace(/\b(Bearer|token|Basic)\s+[^\s'"`]+/gi, (_m, k: string) => `${k} ***`);
  s = s.replace(/\b(token|password|passwd|secret|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&'"`]+)/gi, (_m, k: string, sep: string) => `${k}${sep}***`);
  for (const re of SECRET_PATTERNS) s = s.replace(re, '***');
  // 長い base64 の連なり（大文字・小文字・数字が混ざるものだけ。パスや英単語の連なりは置き換えない）
  s = s.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, (m) => (/[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m) && !m.includes('/') ? '***' : m));
  return s;
}

/** 行頭の # を見出しにしない（前に全角空白を足す） */
function unheading(text: string): string {
  return text.replace(/^([ \t]*#)/gm, '　$1');
}

function describe(i: Incident & { session?: string }): string {
  const head = `- ${INCIDENT_KIND_LABELS[i.kind]}（${i.kind}）${i.target ? ` ${i.target}` : ''}${i.session ? ` [${i.session}:${i.id}]` : ` [${i.id}]`}`;
  const lines = [head, `  - 起きたこと：${unheading(i.what).replace(/\n/g, '\n    ')}`];
  if (i.workaround) lines.push(`  - 回避策：${unheading(i.workaround).replace(/\n/g, '\n    ')}`);
  return lines.join('\n');
}

const TODO = '（人が書く）';

/** 選んだ記録から、Issue Form（.github/ISSUE_TEMPLATE/agent-task.yml）の見出しの下書きを作る。Background に記録を並べ、ほかは空欄 */
export function renderIssueDraft(items: (Incident & { session?: string })[]): string {
  const sections: [string, string][] = [
    ['Goal', TODO],
    ['Background', ['セッションで起きた問題の記録（incident）から作った下書き。', '', ...items.map(describe)].join('\n')],
    ['Requirements', TODO],
    ['Non-goals', TODO],
    ['Acceptance Criteria', `- [ ] ${TODO}`],
    ['Dependencies', '_No response_'],
    ['Validation Requirements', TODO],
  ];
  return maskSecrets(sections.map(([h, b]) => `### ${h}\n\n${b}`).join('\n\n')) + '\n';
}

/** Routine がダッシュボードの Issue に書くコメント本文（#187）。Claude の目印と ```agent-incident ブロック。表示だけで信頼しない */
export function renderIncidentComment(session: string | null, items: (Incident & { session?: string })[]): string {
  const counts = Object.entries(groupByKind(items)).map(([k, v]) => `${INCIDENT_KIND_LABELS[k as IncidentKind]} ${v!.length} 件`);
  const value = { version: 1, session, incidents: items };
  return maskSecrets(
    [claudeMark(session), `セッションの問題の記録（${counts.length > 0 ? counts.join('・') : '0 件'}）。`, '', renderBlock('agent-incident', value)].join('\n'),
  );
}
