// Issue #395：fleet が途中の報告・連絡を hq に status で流し（件名 ready-<PR>・merged-<PR>・verdict-<PR>・wait-<Issue>・notice、
// 相談は ask、送る時機、二重に送らない控え）、答えを待つ Issue があるうちは worker_done しないこと、heartbeat の間隔の見直しと、
// hq の手順7が status を待ち、heartbeat を先に ack して質問を遅らせず、status を振り分ける（すぐ伝える／手順12にためる）ことを、
// fleet と hq の SKILL.md の文で確かめる。文言を丸ごと固定せず、要となる語句だけを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const HQ_SKILL = '.claude/skills/hq/SKILL.md';
const AS_WORKER = '## Orca の worker として動くとき';
const SHIP_WORKER = '## Orca の worker で ship を動かすとき';

/** 見出しの行（前方一致）から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) return '';
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

function mustSection(path: string, heading: string): string {
  const sub = section(read(path), heading);
  assert.ok(sub !== '', `${path} に「${heading}」の節がありません`);
  return sub;
}

/** 番号付きの項目（行頭の `<n>. `）から、次の同じ深さの番号付きの項目の前まで（入れ子の行を含む） */
function item(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\d+\. /.test(l) || /^#+ /.test(l));
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join('\n');
}

function mustItem(where: string, text: string, n: number): string {
  const sub = item(text, n);
  assert.ok(sub !== '', `${where} に項目 ${n} がありません`);
  return sub;
}

function assertWords(where: string, text: string, words: string[]): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${where} に次の語句がありません：${missing.join('、')}`);
}

const asWorker = (): string => mustSection(FLEET_SKILL, AS_WORKER);
const hqStep7 = (): string => mustItem(`${HQ_SKILL} の手順`, read(HQ_SKILL), 7);

// ---- fleet：報告・連絡の種類と件名、送る時機 ----

test('fleet の worker の節：途中の知らせを status で hq に送り、件名で報告・連絡を分ける', () => {
  const where = `${FLEET_SKILL} の「${AS_WORKER}」`;
  assertWords(where, asWorker(), [
    '--type status',
    'ready-<PR>',
    'merged-<PR>',
    'verdict-<PR>',
    'wait-<Issue>',
    'notice',
  ]);
});

test('fleet の worker の節の 8：送る手順・時機・相談は ask・二重に送らない控えがある', () => {
  const where = `${FLEET_SKILL} の「${AS_WORKER}」の 8`;
  const s8 = mustItem(where, asWorker(), 8);
  assertWords(where, s8, ['ORCA orchestration send', '--type status', '--subject', '送る時機', 'ship が返ったとき', 'fleet-status', '相談', '`ask`', 'fleet-hq-sent.json']);
  // 人の判断が要るもの（相談）は status で送らない
  assert.match(s8, /人の判断が要るものは `status` で送らない/, `${where} に「人の判断が要るものは status で送らない」がありません`);
});

// ---- fleet：答えを待つ Issue があるうちは worker_done しない ----

test('fleet の worker の節の 7：hq の答えを待つ Issue があるうちは worker_done しない。待たずに終えるなら release しレポートに書く', () => {
  const where = `${FLEET_SKILL} の「${AS_WORKER}」の 7`;
  const s7 = mustItem(where, asWorker(), 7);
  const line = s7.split('\n').find((l) => l.includes('答えを待っている') && l.includes('worker_done'));
  assert.ok(line, `${where} に「答えを待っている Issue があるうちは worker_done しない」の行がありません`);
  assert.match(line, /`worker_done` を送らない/, `${where} の行に「worker_done を送らない」がありません`);
  assertWords(where, line, ['ask --resume', 'release <番号>', 'レポート', 'message_id']);
});

// ---- fleet：heartbeat の見直しと、ship の worker の heartbeat をすぐ ack ----

test('fleet の worker の節の 6：heartbeat を前置きの間隔より短くせず、status の直後に重ねない', () => {
  const where = `${FLEET_SKILL} の「${AS_WORKER}」の 6`;
  const s6 = mustItem(where, asWorker(), 6);
  assertWords(where, s6, ['heartbeat', '前置きの間隔より短い間隔で送らない', '`status`', '重ねて送らない']);
});

test('fleet の ship の worker の節の 6：束の中の heartbeat はすぐ ack し、question などを後回しにしない', () => {
  const where = `${FLEET_SKILL} の「${SHIP_WORKER}」の 6`;
  const s6 = mustItem(where, mustSection(FLEET_SKILL, SHIP_WORKER), 6);
  const line = s6.split('\n').find((l) => l.includes('heartbeat') && l.includes('--ack'));
  assert.ok(line, `${where} に heartbeat を ack する行がありません`);
  assertWords(where, line, ['すぐ', '後回しにしない', 'question']);
});

// ---- hq の手順7：status の待ち・heartbeat を先に ack・振り分け ----

test('hq の手順7：check --wait の --types に status が入る', () => {
  const s7 = hqStep7();
  const m = s7.match(/--types "([^"]+)"/);
  assert.ok(m, `${HQ_SKILL} の手順7に --types がありません`);
  const types = m[1]!.split(',').map((t) => t.trim());
  for (const t of ['worker_done', 'escalation', 'question', 'status']) {
    assert.ok(types.includes(t), `${HQ_SKILL} の手順7の --types に ${t} がありません`);
  }
});

test('hq の手順7：heartbeat を読んだらすぐ ack し、人への質問を後回しにしない', () => {
  const where = `${HQ_SKILL} の手順7`;
  const s7 = hqStep7();
  assertWords(where, s7, ['heartbeat', '--ack <delivery_id>', '後回しにしない']);
  assert.match(s7, /heartbeat[^\n]*すぐ[^\n]*ack/, `${where} に「heartbeat はすぐ ack」がありません`);
  // 古い言い方（全部処理してから ack）は残さない。heartbeat まで待たせることになるため
  assert.ok(!s7.includes('届いたものを全部処理してから'), `${where} に古い言い方「届いたものを全部処理してから」が残っています`);
});

test('hq の手順7：status を振り分ける（ready-<PR> はすぐ伝え、merged・verdict・wait・notice は手順12にためる）', () => {
  const where = `${HQ_SKILL} の手順7`;
  const s7 = hqStep7();
  const now = s7.split('\n').find((l) => l.includes('すぐ伝える'));
  assert.ok(now, `${where} に「人にすぐ伝える」の行がありません`);
  assertWords(`${where}の「すぐ伝える」`, now, ['ready-<PR>', 'notice']);
  const later = s7.split('\n').find((l) => l.includes('手順12') && l.includes('ためる'));
  assert.ok(later, `${where} に「手順12の一覧にためる」の行がありません`);
  assertWords(`${where}の「ためる」`, later, ['merged-<PR>', 'verdict-<PR>', 'wait-<Issue>', 'notice']);
});

test('hq の手順7：返せなくなった答えは控えに残して新しい fleet に渡し、人に聞き直さない', () => {
  const where = `${HQ_SKILL} の手順7`;
  const s7 = hqStep7();
  const line = s7.split('\n').find((l) => l.includes('dispatch_inactive'));
  assert.ok(line, `${where} に dispatch_inactive の扱いがありません`);
  assertWords(where, line, ['人に聞き直さない', '手順12']);
});

test('hq の手順7：ready-<PR> で届くので gh pr list の仮の見張りは要らない', () => {
  const where = `${HQ_SKILL} の手順7`;
  const line = hqStep7().split('\n').find((l) => l.includes('gh pr list'));
  assert.ok(line, `${where} に gh pr list の仮の見張りの扱いがありません`);
  assertWords(where, line, ['仮の見張り', 'ready-<PR>']);
  assert.match(line, /置かない|要らない/, `${where} に仮の見張りを置かないことがありません`);
});
