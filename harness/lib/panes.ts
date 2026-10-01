import type { FleetClaimInfo, FleetStatusData, FleetStatusRow } from './fleet.ts';

/**
 * fleet のワークスペースのペイン表示（harness/scripts/panes.ts）の、段階の読み替えと描き方。純粋関数だけ。hq の3つのペインは harness/lib/panes-hq.ts。
 * 入力は collect が書いたスナップショット（fleet-status --json の FleetStatusData・PR・usage）だけで、gh・GitHub・ファイルを読まない。
 * 見た目は人が承認した試作（Issue #284）に合わせる。
 */

/** 誰の番か。human だけが「あなたの番」 */
export type PaneWho = 'ai' | 'human' | 'app' | 'wait' | 'done';
/** 段階の位置（計画・批評・ゲート・実装・判定・Merge） */
export type PaneStep = 0 | 1 | 2 | 3 | 4 | 5;

export interface RowLocation {
  step: PaneStep | 'done' | 'stopped' | 'epic';
  who: PaneWho;
  /** 一言 */
  what: string;
  /** ほかのセッションの着手宣言で作業中（あなたの番にしない） */
  other: boolean;
}

export const PANE_STEPS: readonly string[] = ['計画', '批評', 'ゲート', '実装', '判定', 'Merge'];

type Loc = Omit<RowLocation, 'other'>;
const loc = (step: RowLocation['step'], who: PaneWho, what: string): Loc => ({ step, who, what });

/** 着手宣言の段階（harness/lib/queue.ts の CLAIM_STAGES）の位置。表の段階より信じる */
const CLAIM_LOCATION: Record<string, Loc> = {
  plan: loc(0, 'ai', '計画を書いている'),
  'plan-critique': loc(1, 'ai', '計画を批評中'),
  'plan-gate': loc(2, 'app', '計画ゲートの結果待ち'),
  implement: loc(3, 'ai', '実装中'),
  judge: loc(4, 'ai', '判定中'),
  fix: loc(4, 'ai', '修正中'),
  sync: loc(4, 'ai', 'main を取り込み中'),
};

/** 表の段階（stopped・merged 以外）の位置 */
const STAGE_LOCATION: Record<Exclude<FleetStatusRow['stage'], 'stopped' | 'merged'>, Loc> = {
  'no-plan': loc(0, 'ai', '計画の前'),
  'plan-gate': loc(2, 'app', '計画ゲートの結果待ち'),
  'plan-review': loc(2, 'human', '計画ゲートで停止（人の判断待ち）'),
  'plan-ok': loc(3, 'ai', '実装待ち'),
  judge: loc(4, 'ai', '判定待ち'),
  fix: loc(4, 'ai', 'ブロッキング指摘の修正'),
  'human-merge': loc(5, 'human', '人の Merge 待ち'),
  'auto-merge': loc(5, 'app', '自動 Merge 待ち'),
};

/** 重なりや本数で順番を待つとき「待ち」にする段階（人の Merge・App の番はそのまま） */
const QUEUEABLE = new Set<FleetStatusRow['stage']>(['no-plan', 'plan-review', 'plan-ok', 'judge', 'fix']);

const DEPENDENCY = /依存 #/;

/** 行の今の着手宣言（PR の宣言を先に見る） */
const activeClaim = (row: FleetStatusRow): FleetClaimInfo | null => row.prClaim ?? row.claim;

/**
 * fleet-status の1行から、段階の位置と誰の番かを決める。
 * Merge 済み → 止まる印（Epic・依存は待ち、それ以外は人）→ 着手宣言の段階（表の段階より信じる。ほかのセッションの宣言は other）→
 * 重なり・本数の順番待ち → 表の段階、の順に見る。
 */
export function locateRow(row: FleetStatusRow): RowLocation {
  if (row.stage === 'merged') return { ...loc('done', 'done', 'Merge 済み'), other: false };
  if (row.stage === 'stopped') {
    const note = row.note ?? '';
    if (/Epic/.test(note)) return { ...loc('epic', 'wait', '子課題に分けて進めている（Epic）'), other: false };
    const dep = [note, row.waitReason ?? ''].find((s) => DEPENDENCY.test(s));
    if (dep) return { ...loc(0, 'wait', `依存を待っている（${dep.split('。')[0]}）`), other: false };
    return { ...loc('stopped', 'human', note ? `止まっている（${note.split('。')[0]}）` : '止まる印あり'), other: false };
  }
  const claim = activeClaim(row);
  if (claim) {
    const byClaim = claim.stage ? CLAIM_LOCATION[claim.stage] : undefined;
    const base = byClaim ?? { ...STAGE_LOCATION[row.stage], who: 'ai' as const };
    if (!claim.own) return { ...base, what: `ほかのセッションが作業中（${base.what}）`, other: true };
    if (byClaim) return { ...byClaim, other: false };
  }
  if (!row.selected && row.waitReason && QUEUEABLE.has(row.stage)) {
    return { ...STAGE_LOCATION[row.stage], who: 'wait', what: `順番待ち（${row.waitReason}）`, other: false };
  }
  return { ...STAGE_LOCATION[row.stage], other: false };
}

/** 「この状態になった時刻」を更新するかの署名。段階・次にやること・PR・宣言の段階が変われば変わる */
export function rowSignature(row: FleetStatusRow): string {
  const c = activeClaim(row);
  return [row.stage, row.next, row.pr ?? '', c ? `${c.own ? 'own' : 'other'}:${c.stage ?? ''}` : ''].join('|');
}

/** Issue 番号（文字列）→ 署名と、その署名になった時刻 */
export type PaneSince = Record<string, { signature: string; at: string }>;

/** 署名の変わった行（と新しい行）だけ時刻を now にする。行に無い Issue は落とす */
export function nextSince(prev: PaneSince | null, rows: FleetStatusRow[], now: string): PaneSince {
  const out: PaneSince = {};
  for (const row of rows) {
    const signature = rowSignature(row);
    const old = prev?.[String(row.issue)];
    out[String(row.issue)] = old && old.signature === signature ? old : { signature, at: now };
  }
  return out;
}

export interface PanePr {
  number: number;
  title: string;
  /** OPEN・MERGED・CLOSED */
  state: string;
  isDraft: boolean;
  autoMerge: boolean;
  labels: string[];
  checks: { name: string; conclusion: string | null }[];
}

/** 推定料金（USD）。agent.ts usage の estimatedUsd と perModel の estimatedUsd */
export interface PaneUsage {
  totalUsd: number | null;
  perModel: Record<string, number | null>;
}

/** Epic の子課題1つ（collect が sub-issues から読む） */
export interface PaneEpicIssue {
  number: number;
  title: string;
  /** OPEN・CLOSED */
  state: string;
}

/** fleet の Issue の親の Epic と、その子課題（Issue #402） */
export interface PaneEpic {
  number: number;
  title: string;
  state: string;
  children: PaneEpicIssue[];
}

/** collect が書くスナップショット。描くペインはこれだけを読む */
export interface PaneSnapshot {
  version: 1;
  /** 読んだ時刻（ISO） */
  at: string;
  /** fleet のセッションの ID */
  session: string;
  /** hq が付けるテーマの名前。無ければ null */
  label: string | null;
  intervalSeconds: number;
  issues: number[];
  /** fleet-status --json。読めなければ前回のもの（最初から読めなければ null） */
  status: FleetStatusData | null;
  prs: PanePr[];
  /** 読めなければ null */
  usage: PaneUsage | null;
  /** 合計の推移（最大 HISTORY_LIMIT 件） */
  history: { at: string; totalUsd: number | null }[];
  since: PaneSince;
  /** fleet の Issue の親の Epic（Issue #402）。無い古いスナップショットは「Epic なし」扱い */
  epics?: PaneEpic[];
  /** Issue 番号（文字列）→ 親の Epic の番号か null（Issue #402） */
  issueEpic?: Record<string, number | null>;
  /** 読めなかったもの。無ければ null */
  error: string | null;
}

export const HISTORY_LIMIT = 40;

// ---- 見た目の部品 ----

const COLORS = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m', gray: '\x1b[90m' } as const;
export type Color = Exclude<keyof typeof COLORS, 'reset'>;
export const paint = (c: Color, s: string): string => `${COLORS[c]}${s}${COLORS.reset}`;

/** 画面を消す。スクロールも消す（前の描画が上に積もらない） */
export const CLEAR_SCREEN = '\x1b[H\x1b[2J\x1b[3J';

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
  || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
/** 1文字の表示の幅（全角は2） */
export const charWidth = (ch: string): number => (isWide(ch.codePointAt(0)!) ? 2 : 1);

/** 端末での表示の幅（全角は2。色は数えない） */
export function displayWidth(s: string): number {
  let n = 0;
  for (const ch of stripAnsi(s)) n += charWidth(ch);
  return n;
}

/** 幅を超えたら … で切る（色の無い文字列に使う） */
export function clip(s: string, width: number): string {
  if (displayWidth(s) <= width) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const d = charWidth(ch);
    if (n + d > width - 1) break;
    out += ch;
    n += d;
  }
  return `${out}…`;
}

/** 幅までを空白で埋める */
export function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

export interface Mark {
  mark: string;
  meaning: string;
}

/** 進み具合の記号。凡例もこの表から作る（描いた記号と凡例の意味をそろえる） */
export const MARKS = {
  done: { mark: '●', meaning: '済み' },
  ai: { mark: '◉', meaning: 'AI が作業中' },
  human: { mark: '◆', meaning: 'あなたの番' },
  app: { mark: '◌', meaning: 'App 待ち' },
  wait: { mark: '…', meaning: '待ち' },
  todo: { mark: '○', meaning: 'まだ' },
  stopped: { mark: '✖', meaning: '止まっている' },
  epic: { mark: '↳', meaning: '子課題で進める（Epic）' },
} as const satisfies Record<string, Mark>;

export const MARK_COLOR: Record<keyof typeof MARKS, Color> = { done: 'green', ai: 'blue', human: 'magenta', app: 'yellow', wait: 'gray', todo: 'gray', stopped: 'red', epic: 'gray' };
export const WHO_MARK: Record<PaneWho, keyof typeof MARKS> = { ai: 'ai', human: 'human', app: 'app', wait: 'wait', done: 'done' };
const markOf = (k: keyof typeof MARKS): string => paint(MARK_COLOR[k], MARKS[k].mark);

const legend = (): string => paint('gray', (Object.keys(MARKS) as (keyof typeof MARKS)[]).map((k) => `${MARKS[k].mark} ${MARKS[k].meaning}`).join('  '));

export const shortTitle = (title: string): string => title.replace(/^\w+(\([^)]*\))?!?: /, '');
export const shortSession = (session: string): string => session.slice(0, 8);

/** 時刻からの経過（「たった今」「5分前」「1時間3分前」） */
export function ago(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const m = Math.floor((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(m)) return '—';
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  return `${Math.floor(m / 60)}時間${m % 60}分前`;
}

export function rule(title: string, width: number): string {
  const t = ` ${title} `;
  return paint('cyan', `━━${t}${'━'.repeat(Math.max(0, width - displayWidth(t) - 2))}`);
}

function header(snap: PaneSnapshot, title: string, now: number, width: number): string[] {
  const who = snap.label ?? `session ${shortSession(snap.session)}`;
  const every = snap.intervalSeconds >= 60 && snap.intervalSeconds % 60 === 0 ? `${snap.intervalSeconds / 60}分` : `${snap.intervalSeconds}秒`;
  return [rule(`${title}（${who}）`, width), paint('gray', clip(`更新 ${ago(snap.at, now)}（${every}ごと）${snap.error ? `  ⚠ ${snap.error}` : ''}`, width))];
}

const LOADING = (title: string, width: number): string => [rule(title, width), paint('gray', '最初の読み込み中…')].join('\n');

/** 行の宣言の持ち主の一言（このセッション・ほかのセッション） */
function claimOwner(row: FleetStatusRow): string | null {
  const c = activeClaim(row);
  if (!c) return null;
  return c.own ? 'このセッション' : `ほかのセッション${c.session ? `（${shortSession(c.session)}）` : ''}`;
}

/** 6つの段階の横棒（進み具合のペインと hq の Issue のページで使う） */
export function progressBar(at: RowLocation): string {
  const cell = (s: string): string => padEnd(s, 7);
  return PANE_STEPS.map((_, i) => {
    if (at.step === 'stopped') return cell(markOf('stopped'));
    if (at.step === 'epic') return cell(i === 0 ? markOf('epic') : ' ');
    if (at.step === 'done' || i < at.step) return cell(markOf('done'));
    if (i === at.step) return cell(markOf(WHO_MARK[at.who]));
    return cell(markOf('todo'));
  }).join('');
}

/** 進み具合の行 */
function progressLines(snap: PaneSnapshot, now: number, width: number): string[] {
  const out: string[] = [paint('gray', `      ${PANE_STEPS.map((s) => padEnd(s, 7)).join('')}`)];
  for (const row of snap.status?.rows ?? []) {
    const at = locateRow(row);
    const k = WHO_MARK[at.who];
    const label = at.other ? `${MARKS.ai.mark} ほかのセッションが作業中` : `${MARKS[k].mark} ${MARKS[k].meaning}`;
    const owner = claimOwner(row);
    out.push(`${paint('bold', padEnd(`#${row.issue}`, 6))}${progressBar(at)}`);
    out.push(`      ${paint('dim', clip(shortTitle(row.title), width - 6))}`);
    const parts = [paint(MARK_COLOR[at.other ? 'ai' : k], label), at.what];
    if (owner) parts.push(paint('gray', `宣言：${owner}`));
    if (row.pr !== null) parts.push(paint('cyan', `PR #${row.pr}`));
    parts.push(paint('gray', `この状態になって ${ago(snap.since[String(row.issue)]?.at, now)}`));
    out.push(`      ${parts.join('  ')}`);
    if (!row.selected && row.waitReason) out.push(`      ${paint('yellow', clip(`待つ理由：${row.waitReason}`, width - 6))}`);
    out.push('');
  }
  return out;
}

/** 進み具合のペイン：6つの段階の横棒と、誰の番・一言・PR・この状態になってからの時間、待つ理由、凡例 */
export function renderProgress(snap: PaneSnapshot | null, now: number, width: number): string {
  if (!snap) return LOADING('fleet の進み具合', width);
  const out = [...header(snap, 'fleet の進み具合', now, width)];
  if (!snap.status) out.push(paint('gray', '  fleet-status がまだ読めていません'));
  else out.push(...progressLines(snap, now, width));
  out.push(legend());
  return out.join('\n');
}

export interface TodoItem {
  /** 並び順（0：人の Merge 待ち → 1：計画ゲートで停止・test:exempt の判断 → 2：止まる印） */
  rank: number;
  issue: number;
  pr: number | null;
  text: string;
  sub: string;
}

const TEST_CHECK = 'agent/tests';
const TEST_EXEMPT = 'test:exempt';

/** 人がすること（human の行と、自動 Merge の対象の PR で agent/tests が止めたもの） */
export function todoItems(snap: PaneSnapshot): TodoItem[] {
  const items: TodoItem[] = [];
  const rows = snap.status?.rows ?? [];
  for (const row of rows) {
    const at = locateRow(row);
    if (at.who !== 'human' || at.other) continue;
    if (row.stage === 'human-merge') items.push({ rank: 0, issue: row.issue, pr: row.pr, text: `PR #${row.pr}（#${row.issue}）を確かめて Merge する`, sub: 'Human Merge の依頼のコメントに確かめる点がある' });
    else if (row.stage === 'plan-review') items.push({ rank: 1, issue: row.issue, pr: null, text: `#${row.issue} の計画が計画ゲートで止まっている → 進めてよいか決める`, sub: 'fleet のペインで聞かれたら答える' });
    else items.push({ rank: 2, issue: row.issue, pr: row.pr, text: `#${row.issue}：${at.what}`, sub: '' });
  }
  for (const pr of snap.prs) {
    const row = rows.find((r) => r.pr === pr.number);
    const auto = pr.autoMerge || row?.stage === 'auto-merge';
    const tests = pr.checks.find((c) => c.name === TEST_CHECK);
    if (auto && tests?.conclusion === 'FAILURE' && !pr.labels.includes(TEST_EXEMPT)) {
      items.push({ rank: 1, issue: row?.issue ?? 0, pr: pr.number, text: `PR #${pr.number} の ${TEST_CHECK} が止めた → ${TEST_EXEMPT} を付けるか決める`, sub: 'PR のコメントに理由がある' });
    }
  }
  return items.sort((a, b) => a.rank - b.rank);
}

function todoLines(items: TodoItem[], width: number, prefix = (_: TodoItem): string => ''): string[] {
  if (items.length === 0) return [paint('green', '  いまは何もありません。AI と App の番です。')];
  const out: string[] = [];
  items.forEach((it, i) => {
    out.push(`${paint('magenta', ` ${i + 1}.`)} ${clip(`${prefix(it)}${it.text}`, width - 4)}`);
    if (it.sub) out.push(`    ${paint('gray', clip(it.sub, width - 4))}`);
  });
  return out;
}

/** あなたがすることのペイン */
export function renderTodo(snap: PaneSnapshot | null, now: number, width: number): string {
  if (!snap) return LOADING('あなたがすること', width);
  const out = [...header(snap, 'あなたがすること', now, width), ...todoLines(todoItems(snap), width)];
  const others = (snap.status?.rows ?? []).filter((r) => { const at = locateRow(r); return at.who !== 'human' && at.who !== 'done'; }).length;
  out.push('', paint('gray', `ほかに ${others} 件は AI・App が進めているか、順番を待っている`));
  return out.join('\n');
}

function checkMark(conclusion: string | null): string {
  if (conclusion === 'SUCCESS') return paint('green', '✓');
  if (conclusion === 'FAILURE' || conclusion === 'ERROR') return paint('red', '✗');
  if (conclusion === 'NEUTRAL' || conclusion === 'SKIPPED') return paint('gray', '–');
  return paint('yellow', '…');
}

function prState(pr: PanePr): string {
  if (pr.state === 'MERGED') return paint('green', 'Merge 済み');
  if (pr.state === 'CLOSED') return paint('gray', 'Close 済み');
  if (pr.isDraft) return paint('gray', 'Draft（判定前）');
  if (pr.autoMerge) return paint('yellow', 'Ready・自動 Merge 待ち');
  return paint('magenta', 'Ready・人の Merge 待ち');
}

const SPARK = '▁▂▃▄▅▆▇█';
const HOUR = 3600000;

/** 直近の1時間の合計の増え方（USD/時）。2点に満たなければ null */
function pacePerHour(history: PaneSnapshot['history'], now: number): number | null {
  const h = history.filter((x): x is { at: string; totalUsd: number } => x.totalUsd !== null);
  if (h.length < 2) return null;
  const last = h[h.length - 1]!;
  const first = h.find((x) => now - Date.parse(x.at) <= HOUR) ?? h[0]!;
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / HOUR;
  if (first === last || hours <= 0) return null;
  return (last.totalUsd - first.totalUsd) / hours;
}

/** PR と費用のペイン：PR ごとの状態とチェック、推定料金の合計・モデル別・直近の1時間のペース・推移の小さなグラフ */
export function renderPrs(snap: PaneSnapshot | null, now: number, width: number): string {
  if (!snap) return LOADING('PR と費用', width);
  const out = [...header(snap, 'PR と費用', now, width)];
  if (snap.prs.length === 0) out.push(paint('gray', '  fleet の PR はまだありません'));
  for (const pr of snap.prs) {
    out.push(`${paint('bold', `PR #${pr.number}`)}  ${prState(pr)}`);
    out.push(`  ${paint('dim', clip(shortTitle(pr.title), width - 2))}`);
    const checks = pr.checks.filter((c) => c.name !== 'gate');
    if (checks.length > 0) out.push(`  ${checks.map((c) => `${checkMark(c.conclusion)} ${c.name.replace(/^agent\//, '')}`).join('  ')}`);
    const risk = pr.labels.find((n) => n.startsWith('risk:'));
    if (risk) out.push(`  ${paint('gray', risk)}`);
    out.push('');
  }
  out.push(rule('費用（推定）', width));
  const u = snap.usage;
  if (!u) {
    out.push(paint('gray', '  読めませんでした'));
    return out.join('\n');
  }
  const pace = pacePerHour(snap.history, now);
  out.push(`  合計 ${paint('bold', `${u.totalUsd === null ? '—' : u.totalUsd.toFixed(2)} USD`)}${pace !== null ? paint('gray', `   直近のペース 約 ${pace.toFixed(2)} USD/時`) : ''}`);
  for (const [m, v] of Object.entries(u.perModel)) out.push(paint('gray', `  ${padEnd(m.replace(/^claude-/, ''), 24)} ${(v === null ? '—' : v.toFixed(2)).padStart(7)} USD`));
  const vals = snap.history.slice(-24).map((x) => x.totalUsd).filter((v): v is number => v !== null);
  if (vals.length > 1) {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const spark = vals.map((v) => SPARK[hi === lo ? 0 : Math.round(((v - lo) / (hi - lo)) * 7)]).join('');
    out.push(`  ${paint('cyan', spark)} ${paint('gray', '（合計の推移）')}`);
  }
  return out.join('\n');
}
