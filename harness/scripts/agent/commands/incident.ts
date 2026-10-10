import { appendIncident, groupByKind, type Incident, INCIDENT_KIND_LABELS, INCIDENT_KINDS, type IncidentKind, isIncidentKind, isValidSession, listSessions, readIncidents, renderIncidentComment, renderIssueDraft } from '../../../lib/incident.ts';
import { loadConfig } from '../../../lib/config.ts';
import { INCIDENT_TRIAGE_CLASSES, isIncidentTriageClass, listTriageSessions, readTriage, triageIncident, triageStats } from '../../../lib/incident-triage.ts';
import { parseTitle } from '../../../lib/title.ts';
import { type AgentCommand, fail } from '../cli.ts';

/**
 * セッションで起きた問題の記録（Issue #186）。GitHub を読み書きしない。記録はリポジトリの外の、セッションごとのファイル
 * （AGENT_HARNESS_INCIDENT_DIR、無ければホームの下の .agent-harness/incidents/<セッションID>.jsonl）。
 * セッションは --session <id>（list・render-* は繰り返せる。/clear で分かれた前のセッションも合わせて読む）、無ければ AGENT_HARNESS_SESSION。
 *
 *   node harness/scripts/agent.ts incident add --kind <種類> --what <文> [--target <#n|PR #n>] [--workaround <文>] [--session <id>]
 *                                                           1件記録し、id を出す。種類は deny / return-to-human / app-reject / human-correction / workaround
 *   node harness/scripts/agent.ts incident list [--session <id>]... [--json]   種類ごとにまとめて出す（--json は種類ごとの JSON。各項目に session）
 *   node harness/scripts/agent.ts incident sessions                      記録のあるセッション ID を新しい順に出す
 *   node harness/scripts/agent.ts incident render-issue <id>... --title <題> [--session <id>]...
 *                                                           選んだ記録から Issue Form の形の下書きの本文を出す（id は数字か <セッションID>:<数字>。題は Conventional Commits）
 *   node harness/scripts/agent.ts incident triage <id> --as <harness|environment|once> [--session <id>]
 *                                                           記録1件の振り分けを Jev に問い、セッションの振り分けと並べて <セッションID>.triage.jsonl に残す（shadow。振り分けは変えない。JEV_API_KEY が無ければ skipped。#498）
 *   node harness/scripts/agent.ts incident triage-stats [--json]  全セッションの振り分けの記録を集計して出す（一致の割合・組み合わせ）
 *   node harness/scripts/agent.ts incident render-comment [--session <id>]...  Routine がダッシュボードに書くコメント本文（```agent-incident。#187）
 */

type Item = Incident & { session: string };

interface Parsed {
  positional: string[];
  sessions: string[];
  flags: Map<string, string>;
  json: boolean;
}

const VALUE_FLAGS = ['--kind', '--what', '--target', '--workaround', '--title', '--as'];

function parseArgs(args: string[]): Parsed {
  const out: Parsed = { positional: [], sessions: [], flags: new Map(), json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') out.json = true;
    else if (a === '--session' || VALUE_FLAGS.includes(a)) {
      const v = args[++i];
      if (v === undefined) fail([`${a} に値がありません`]);
      if (a === '--session') out.sessions.push(v);
      else out.flags.set(a, v);
    } else if (a.startsWith('--')) fail([`知らないオプションです: ${a}`]);
    else out.positional.push(a);
  }
  return out;
}

/** 使うセッション。--session が無ければ AGENT_HARNESS_SESSION。どちらも無い・形が違えば止める */
function sessionsOf(p: Parsed): string[] {
  const sessions = p.sessions.length > 0 ? p.sessions : process.env.AGENT_HARNESS_SESSION ? [process.env.AGENT_HARNESS_SESSION] : [];
  if (sessions.length === 0) fail(['セッション ID がありません（--session <id> か AGENT_HARNESS_SESSION）']);
  for (const s of sessions) if (!isValidSession(s)) fail([`セッション ID は英数字と - _ だけ使えます: ${s}`]);
  return [...new Set(sessions)];
}

function readAll(sessions: string[]): Item[] {
  return sessions.flatMap((session) => readIncidents(session, process.env).map((i) => ({ ...i, session })));
}

function add(p: Parsed): void {
  const [session] = sessionsOf(p);
  const kind = p.flags.get('--kind');
  const what = p.flags.get('--what');
  if (!isIncidentKind(kind)) fail([`--kind は ${INCIDENT_KINDS.join(' / ')} のいずれか`]);
  if (!what || what.trim() === '') fail(['--what が要ります']);
  const item = appendIncident(session!, { kind, what, target: p.flags.get('--target'), workaround: p.flags.get('--workaround'), source: 'session' }, process.env);
  console.log(String(item.id));
}

function list(p: Parsed): void {
  const items = readAll(sessionsOf(p));
  const grouped = groupByKind(items);
  if (p.json) {
    console.log(JSON.stringify(grouped, null, 2));
    return;
  }
  if (items.length === 0) {
    console.log('記録はありません');
    return;
  }
  const lines: string[] = [];
  for (const [kind, list] of Object.entries(grouped) as [IncidentKind, Item[]][]) {
    lines.push(`## ${INCIDENT_KIND_LABELS[kind]}（${kind}）`, '');
    for (const i of list) {
      lines.push(`- [${i.session}:${i.id}] ${i.target ? `${i.target} ` : ''}${i.what.replace(/\n/g, ' ')}${i.workaround ? `（回避策：${i.workaround.replace(/\n/g, ' ')}）` : ''}`);
    }
    lines.push('');
  }
  console.log(lines.join('\n').trimEnd());
}

function renderIssue(p: Parsed): void {
  const sessions = sessionsOf(p);
  const title = p.flags.get('--title');
  if (!title) fail(['--title が要ります']);
  const t = parseTitle(title);
  if (!t.ok) fail([t.error]);
  if (p.positional.length === 0) fail(['記録の id を1つ以上渡してください']);
  const items = readAll(sessions);
  const picked: Item[] = [];
  for (const ref of p.positional) {
    const at = ref.lastIndexOf(':');
    const session = at < 0 ? sessions[0]! : ref.slice(0, at);
    const num = ref.slice(at + 1);
    if (!/^\d+$/.test(num) || !isValidSession(session)) fail([`id は数字か <セッションID>:<数字>: ${ref}`]);
    const found = items.find((i) => i.session === session && i.id === Number(num));
    if (!found) fail([`記録が見つかりません: ${ref}（--session に含めたセッションだけを読みます）`]);
    if (!picked.includes(found)) picked.push(found);
  }
  process.stdout.write(renderIssueDraft(picked));
}

function renderComment(p: Parsed): void {
  const sessions = sessionsOf(p);
  console.log(renderIncidentComment(sessions[0] ?? null, readAll(sessions)));
}

async function triage(p: Parsed): Promise<void> {
  const [session] = sessionsOf(p);
  const as = p.flags.get('--as');
  if (!isIncidentTriageClass(as)) fail([`--as は ${INCIDENT_TRIAGE_CLASSES.join(' / ')} のいずれか`]);
  const ref = p.positional[0];
  if (!ref || !/^\d+$/.test(ref)) fail(['記録の id（数字）を1つ渡してください']);
  const incident = readIncidents(session!, process.env).find((i) => i.id === Number(ref));
  if (!incident) fail([`記録が見つかりません: ${session}:${ref}`]);
  const r = await triageIncident(loadConfig(), process.env.JEV_API_KEY, session!, incident, as, process.env);
  const jev = r.jev.status === 'ok' ? `${r.jev.top}（${Math.round(r.jev.probabilities[r.jev.top] * 100)}%）、${r.agree ? '一致' : '不一致'}` : `${r.jev.status}（${r.jev.detail}）`;
  console.log(`[${session}:${r.incidentId}] セッション: ${r.session} / Jev: ${jev}`);
}

function triageStatsCommand(p: Parsed): void {
  const rows = listTriageSessions(process.env).flatMap((session) => readTriage(session, process.env).map((record) => ({ session, record })));
  const s = triageStats(rows);
  if (p.json) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  if (s.total === 0) {
    console.log('振り分けの記録はありません');
    return;
  }
  const pct = s.ok === 0 ? '-' : `${Math.round((s.agree / s.ok) * 100)}%`;
  const lines = [`振り分けの記録 ${s.total} 件：Jev の答えあり ${s.ok}（一致 ${s.agree}、一致率 ${pct}）、skipped ${s.skipped}、error ${s.error}`];
  for (const [k, n] of Object.entries(s.pairs).sort()) lines.push(`- セッション→Jev ${k}：${n}`);
  console.log(lines.join('\n'));
}

export const commands: AgentCommand[] = [
  {
    name: 'incident',
    run: (args) => {
      const [sub, ...rest] = args;
      const p = parseArgs(rest);
      try {
        switch (sub) {
          case 'add':
            return add(p);
          case 'list':
            return list(p);
          case 'sessions':
            return void console.log(listSessions(process.env).join('\n'));
          case 'triage':
            return triage(p).catch((e) => fail([(e as Error).message]));
          case 'triage-stats':
            return triageStatsCommand(p);
          case 'render-issue':
            return renderIssue(p);
          case 'render-comment':
            return renderComment(p);
          default:
            fail(['incident のサブコマンドは add / list / sessions / triage / triage-stats / render-issue / render-comment']);
        }
      } catch (e) {
        fail([(e as Error).message]);
      }
    },
  },
];
