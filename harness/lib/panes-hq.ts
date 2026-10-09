/**
 * hq の3つのペイン（上から Epic/Issue・人待ち・ログ）の描き方と、hq の控えから今動いている fleet を見つけること。純粋関数だけ（Issue #402）。
 * CLI は harness/scripts/panes.ts の hq todo・hq board・hq log。
 * 入力は hq の控え（harness/scripts/hq-state.ts の hq-fleets.json）の fleets と、collect が書いた fleet のスナップショットだけで、gh・GitHub・ファイルを読まない。
 * 段階の読み替え・記号・人がすることは harness/lib/panes.ts と同じものを使う。
 */
import type { FleetStatusRow } from './fleet.ts';
import {
  MARKS, MARK_COLOR, PANE_STEPS, WHO_MARK, ago, charWidth, displayWidth, locateRow, paint, progressBar, rule, shortTitle, todoItems,
  type PaneSnapshot, type TodoItem,
} from './panes.ts';

/** 控えの fleet 1つ（hq が起こした fleet。session は fleet から届くまで null） */
export interface HqFleet {
  theme: string;
  epic: number | null;
  session: string | null;
  startedAt: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** 控えの fleets を読む。形の違う項目は、読める値だけを使う。控えが無ければ [] */
export function ledgerFleets(ledger: { fleets: Record<string, unknown>[] } | null): HqFleet[] {
  if (!ledger || !Array.isArray(ledger.fleets)) return [];
  return ledger.fleets.filter(isObj).map((f) => {
    const session = nonEmpty(f.session);
    const epic = typeof f.epic === 'number' && Number.isInteger(f.epic) && f.epic > 0 ? f.epic : null;
    return {
      theme: nonEmpty(f.theme) ?? (session ? session.slice(0, 8) : '（名前なし）'),
      epic,
      session,
      startedAt: typeof f.startedAt === 'string' ? f.startedAt : null,
    };
  });
}

/** ok：読めた／starting：起動中（最初の collect の前）／missing：スナップショットが無い／stale：更新が古い／error：読めなかったものがある */
export type HqFleetState = 'ok' | 'starting' | 'missing' | 'stale' | 'error';

export interface HqFleetView {
  fleet: HqFleet;
  snap: PaneSnapshot | null;
  state: HqFleetState;
}

export interface HqView {
  /** 控えが読めたか */
  ledger: boolean;
  fleets: HqFleetView[];
}

const MINUTE = 60000;

/** 控えの fleet ごとにスナップショットを読み、状態を決める。控えに無いセッションのスナップショットは読まない */
export function readHqView(
  ledger: { fleets: Record<string, unknown>[] } | null,
  readSnapshot: (session: string) => PaneSnapshot | null,
  now: number,
  staleMinutes: number,
): HqView {
  if (!ledger) return { ledger: false, fleets: [] };
  const limit = staleMinutes * MINUTE;
  const fleets = ledgerFleets(ledger).map((fleet): HqFleetView => {
    if (!fleet.session) return { fleet, snap: null, state: 'starting' };
    const snap = readSnapshot(fleet.session);
    if (!snap) {
      const started = fleet.startedAt ? Date.parse(fleet.startedAt) : NaN;
      return { fleet, snap: null, state: Number.isFinite(started) && now - started <= limit ? 'starting' : 'missing' };
    }
    const at = Date.parse(snap.at);
    if (!Number.isFinite(at) || now - at > limit) return { fleet, snap, state: 'stale' };
    return { fleet, snap, state: snap.error ? 'error' : 'ok' };
  });
  return { ledger: true, fleets };
}

/** 読めない・古いスナップショットの注意の1行。無ければ null */
export function hqWarning(view: HqView, now: number): string | null {
  if (!view.ledger) return '⚠ hq の控え（hq-fleets.json）が読めない（まだ無いか、形が違う）';
  const parts = view.fleets.flatMap(({ fleet, snap, state }) => {
    if (state === 'missing') return [`${fleet.theme}：スナップショットが無い`];
    if (state === 'stale') return [`${fleet.theme}：更新が ${ago(snap?.at, now)}`];
    if (state === 'error') return [`${fleet.theme}：${snap?.error ?? ''}`];
    return [];
  });
  return parts.length > 0 ? `⚠ ${parts.join(' / ')}` : null;
}

// ---- 折り返し ----

const isWordChar = (ch: string): boolean => /^[\x21-\x7e]$/.test(ch);

/** 幅で折り返す（省略しない）。空白を含まない ASCII の並びは途中で切らず、幅より長い語だけは切る。全角は幅2 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width);
  // 語（ASCII の並び）・空白・それ以外の1文字に分ける
  const tokens = text.match(/[\x21-\x7e]+|\s+|[^\s\x21-\x7e]/gu) ?? [];
  const lines: string[] = [];
  let line = '';
  let n = 0;
  const flush = (): void => {
    lines.push(line.replace(/\s+$/u, ''));
    line = '';
    n = 0;
  };
  for (const tok of tokens) {
    if (/^\s+$/u.test(tok)) {
      if (n === 0) continue;
      if (n + 1 > w) flush();
      else { line += ' '; n += 1; }
      continue;
    }
    const tw = displayWidth(tok);
    if (n + tw <= w) { line += tok; n += tw; continue; }
    if (isWordChar(tok[0]!) && tw <= w) { flush(); line = tok; n = tw; continue; }
    // 幅より長い語か、全角などの1文字：入るところまで入れて折り返す
    for (const ch of tok) {
      const d = charWidth(ch);
      if (n + d > w && n > 0) flush();
      line += ch;
      n += d;
    }
  }
  if (line !== '' || lines.length === 0) flush();
  return lines;
}

const indent = (lines: string[], pad: string, color?: Parameters<typeof paint>[0]): string[] => lines.map((l) => `${pad}${color ? paint(color, l) : l}`);
const wrapped = (text: string, width: number, pad: string, color?: Parameters<typeof paint>[0]): string[] => indent(wrapText(text, width - displayWidth(pad)), pad, color);

// ---- 共通 ----

interface FleetRow {
  view: HqFleetView;
  row: FleetStatusRow;
}

const rowsOf = (view: HqView): FleetRow[] => view.fleets.flatMap((v) => (v.snap?.status?.rows ?? []).map((row) => ({ view: v, row })));

function heading(title: string, view: HqView, now: number, width: number): string[] {
  const out = [rule(title, width)];
  const warn = hqWarning(view, now);
  if (warn) out.push(...wrapped(warn, width, '', 'yellow'));
  return out;
}

// ---- ② 人待ち ----

/** ② 人待ち：全 fleet の人がすること。無ければ「今はありません」と、AI・App が進行中の件数 */
export function renderHqTodo(view: HqView, now: number, width: number, maxFleets: number): string {
  const out = heading('人待ち（全 fleet）', view, now, width);
  if (view.fleets.length > maxFleets) out.push(...wrapped(`⚠ fleet が ${view.fleets.length} 個あります（hq.maxFleets は ${maxFleets}）。同時に動かす fleet を減らしてください`, width, '', 'yellow'));
  const items: { it: TodoItem; theme: string }[] = view.fleets
    .flatMap((v) => (v.snap ? todoItems(v.snap).map((it) => ({ it, theme: v.fleet.theme })) : []))
    .sort((a, b) => a.it.rank - b.it.rank);
  if (items.length === 0) {
    const busy = rowsOf(view).filter(({ row }) => { const at = locateRow(row); return at.who !== 'human' && at.who !== 'done'; }).length;
    out.push(paint('green', '今はありません'), paint('gray', `AI・App が進行中 ${busy} 件`));
    return out.join('\n');
  }
  items.forEach(({ it, theme }, i) => {
    const num = ` ${i + 1}. `;
    const pad = ' '.repeat(displayWidth(num));
    const lines = wrapText(`[${theme}] ${it.text}`, width - displayWidth(num));
    out.push(`${paint('magenta', num)}${lines[0] ?? ''}`, ...lines.slice(1).map((l) => `${pad}${l}`));
    if (it.sub) out.push(...wrapped(it.sub, width, pad, 'gray'));
  });
  return out.join('\n');
}

// ---- ① Epic/Issue ----

export type BoardPage = 'epic' | 'issue';

/** Tab は切り替え、e は Epic、i は Issue。ほかのキーはそのまま */
export function nextBoardPage(page: BoardPage, key: string): BoardPage {
  if (key === '\t') return page === 'epic' ? 'issue' : 'epic';
  if (key === 'e') return 'epic';
  if (key === 'i') return 'issue';
  return page;
}

interface EpicGroup {
  number: number;
  title: string | null;
  children: { number: number; state: string }[] | null;
  themes: Set<string>;
  rows: FleetRow[];
}

/** Epic ごとのまとまりと、Epic に入っていない行 */
function groupByEpic(view: HqView): { epics: EpicGroup[]; none: FleetRow[] } {
  const epics = new Map<number, EpicGroup>();
  const get = (n: number): EpicGroup => {
    let g = epics.get(n);
    if (!g) { g = { number: n, title: null, children: null, themes: new Set(), rows: [] }; epics.set(n, g); }
    return g;
  };
  for (const v of view.fleets) {
    for (const e of v.snap?.epics ?? []) {
      const g = get(e.number);
      g.title = e.title;
      g.children = e.children.map((c) => ({ number: c.number, state: c.state }));
      g.themes.add(v.fleet.theme);
    }
    if (!v.snap && v.fleet.epic !== null) get(v.fleet.epic).themes.add(v.state === 'starting' ? `${v.fleet.theme}（起動中）` : v.fleet.theme);
  }
  const none: FleetRow[] = [];
  for (const fr of rowsOf(view)) {
    const parent = fr.view.snap?.issueEpic?.[String(fr.row.issue)] ?? null;
    if (parent !== null) {
      const g = get(parent);
      g.rows.push(fr);
      g.themes.add(fr.view.fleet.theme);
    } else if (!epics.has(fr.row.issue)) none.push(fr);
  }
  return { epics: [...epics.values()].sort((a, b) => a.number - b.number), none };
}

const todoCount = (rows: FleetRow[]): number => rows.filter(({ view, row }) => view.snap && todoItems(view.snap).some((it) => it.issue === row.issue)).length;

function closeBar(closed: number, total: number): string {
  const cells = Math.min(total, 10);
  const filled = total === 0 ? 0 : Math.round((closed / total) * cells);
  return `${paint('green', '■'.repeat(filled))}${paint('gray', '□'.repeat(cells - filled))}`;
}

function epicPage(view: HqView, width: number): string[] {
  const { epics, none } = groupByEpic(view);
  const out: string[] = [];
  if (epics.length === 0 && none.length === 0) out.push(paint('gray', '  fleet の Issue がまだありません'));
  for (const g of epics) {
    const themes = [...g.themes].join('・');
    const waiting = todoCount(g.rows);
    if (g.children) {
      const total = g.children.length;
      const closed = g.children.filter((c) => c.state === 'CLOSED').length;
      out.push(`${closeBar(closed, total)}  ${paint('bold', `${closed}/${total}`)}  ${paint(waiting > 0 ? 'magenta' : 'gray', `人待ち ${waiting}`)}  ${paint('bold', `#${g.number}`)}  ${paint('cyan', themes)}`);
    } else {
      out.push(`${paint('gray', 'まだ読めていない')}  ${paint('bold', `#${g.number}`)}  ${paint('cyan', themes)}`);
    }
    if (g.title) out.push(...wrapped(shortTitle(g.title), width, '    ', 'dim'));
  }
  if (none.length > 0) out.push('', `${paint('bold', `Epic なし ${none.length} 件`)}  ${paint('gray', none.map(({ row }) => `#${row.issue}`).join(' '))}`);
  return out;
}

function issueLines(fr: FleetRow, now: number, width: number): string[] {
  const { row, view } = fr;
  const at = locateRow(row);
  const k = WHO_MARK[at.who];
  const label = at.other ? `${MARKS.ai.mark} ほかのセッションが作業中` : `${MARKS[k].mark} ${MARKS[k].meaning}`;
  const out = [`${paint('bold', `#${row.issue}`.padEnd(6))}${progressBar(at)}`];
  out.push(...wrapped(shortTitle(row.title), width, '      ', 'dim'));
  const parts = [paint(MARK_COLOR[at.other ? 'ai' : k], label), at.what];
  if (row.pr !== null) parts.push(paint('cyan', `PR #${row.pr}`));
  parts.push(paint('gray', `この状態になって ${ago(view.snap?.since[String(row.issue)]?.at, now)}`));
  out.push(`      ${parts.join('  ')}`);
  if (!row.selected && row.waitReason) out.push(...wrapped(`待つ理由：${row.waitReason}`, width, '      ', 'yellow'));
  return out;
}

function issueGroup(title: string, rows: FleetRow[], now: number, width: number): string[] {
  const out = ['', ...wrapped(title, width, '', 'bold')];
  const done = rows.filter(({ row }) => row.stage === 'merged');
  for (const fr of rows) if (fr.row.stage !== 'merged') out.push(...issueLines(fr, now, width));
  if (done.length > 0) out.push(...wrapped(`${MARKS.done.mark} 済み ${done.length} 件：${done.map(({ row }) => `#${row.issue}`).join(' ')}`, width, '      ', 'green'));
  if (rows.length === 0) out.push(paint('gray', '      まだ読めていない'));
  return out;
}

function issuePage(view: HqView, now: number, width: number): string[] {
  const { epics, none } = groupByEpic(view);
  const out = [paint('gray', `      ${PANE_STEPS.map((s) => s + ' '.repeat(Math.max(0, 7 - displayWidth(s)))).join('')}`)];
  for (const g of epics) out.push(...issueGroup(`#${g.number}${g.title ? ` ${shortTitle(g.title)}` : ''}（${[...g.themes].join('・')}）`, g.rows, now, width));
  if (none.length > 0) out.push(...issueGroup('Epic なし', none, now, width));
  return out;
}

/** ① Epic/Issue：Epic のページ（Close の数・人待ちの数・Epic なしの件数）と Issue のページ（Epic ごとの6段階の横棒）を Tab・e・i で切り替える */
export function renderHqBoard(view: HqView, page: BoardPage, now: number, width: number): string {
  const title = page === 'epic' ? 'Epic（Tab・e・i で切り替え）' : 'Issue（Tab・e・i で切り替え）';
  const out = heading(title, view, now, width);
  out.push(...(page === 'epic' ? epicPage(view, width) : issuePage(view, now, width)));
  return out.join('\n');
}

// ---- ③ ログ ----

const two = (n: number): string => String(n).padStart(2, '0');
const hhmm = (iso: string): string => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

/** ③ ログ：状態が変わった Issue を新しい順に1行ずつ（時刻・記号・番号・一言・PR）。ペインの高さに収まる分だけ */
export function renderHqLog(view: HqView, now: number, width: number, height: number): string {
  const out = heading('ログ（新しい順）', view, now, width);
  const entries = rowsOf(view)
    .map((fr) => ({ ...fr, at: fr.view.snap?.since[String(fr.row.issue)]?.at ?? null }))
    .filter((e): e is FleetRow & { at: string } => e.at !== null && Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  if (entries.length === 0) out.push(paint('gray', '  まだありません'));
  for (const e of entries) {
    const at = locateRow(e.row);
    const k = at.step === 'done' ? 'done' : at.step === 'stopped' ? 'stopped' : WHO_MARK[at.other ? 'ai' : at.who];
    const line = `${paint('gray', hhmm(e.at))} ${paint(MARK_COLOR[k], MARKS[k].mark)} ${paint('bold', `#${e.row.issue}`)} ${at.what}${e.row.pr !== null ? `  ${paint('cyan', `PR #${e.row.pr}`)}` : ''}`;
    out.push(clipLine(line, width));
  }
  return out.slice(0, Math.max(1, height)).join('\n');
}

/** 色つきの1行を幅で切る（ログは1行ずつなので、はみ出した分は端末に任せず落とす） */
function clipLine(line: string, width: number): string {
  if (displayWidth(line) <= width) return line;
  let out = '';
  let n = 0;
  for (const m of line.matchAll(/\x1b\[[0-9;]*m|[\s\S]/gu)) {
    const t = m[0];
    if (t.startsWith('\x1b')) { out += t; continue; }
    const d = charWidth(t);
    if (n + d > width) break;
    out += t;
    n += d;
  }
  return `${out}\x1b[0m`;
}
