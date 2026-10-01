// Issue #425：hq に Orca の worker として起こされた fleet が、定期の heartbeat の本文（--body）に今の状況を一言
// （Issue 番号・段階・次にすること・待っているもの）入れ、質問は載せないこと、hq がその一言をログのペインと
// 手順12の人がすることの一覧に使い、heartbeat はすぐ ack して質問を遅らせないことを、fleet と hq の SKILL.md の文で確かめる。
// 文言を丸ごと固定せず、要となる語句だけを確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const HQ_SKILL = '.claude/skills/hq/SKILL.md';
const AS_WORKER = '## Orca の worker として動くとき';

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

function fleetWorkerStep6(): string {
  const sub = section(read(FLEET_SKILL), AS_WORKER);
  assert.ok(sub !== '', `${FLEET_SKILL} に「${AS_WORKER}」の節がありません`);
  return mustItem(`${FLEET_SKILL} の「${AS_WORKER}」`, sub, 6);
}

const hqStep = (n: number): string => mustItem(`${HQ_SKILL} の手順`, read(HQ_SKILL), n);

// ---- fleet：heartbeat の本文に今の状況を一言 ----

test('fleet の worker の節の 6：heartbeat の本文（--body）に今の状況を一言入れ、入れるもの（Issue 番号・段階・次にすること・待っているもの）と例がある', () => {
  const where = `${FLEET_SKILL} の「${AS_WORKER}」の 6`;
  assertWords(where, fleetWorkerStep6(), [
    'heartbeat の本文に今の状況を一言入れる',
    '`--body`',
    'Issue 番号・段階・次にすること・待っているもの',
    '#388 実装中、次は判定',
  ]);
});

test('fleet の worker の節の 6：heartbeat に質問を載せない', () => {
  const where = `${FLEET_SKILL} の「${AS_WORKER}」の 6`;
  assertWords(where, fleetWorkerStep6(), ['heartbeat に質問を載せない']);
});

// ---- hq：worker を起こす指示と、heartbeat の一言の使い道 ----

test('hq の手順4：fleet を起こす指示に、heartbeat の本文に今の状況を一言入れることがある', () => {
  assertWords(`${HQ_SKILL} の手順4`, hqStep(4), ['heartbeat の本文に今の状況を一言入れる']);
});

test('hq の手順7：heartbeat の一言をログのペインに使い、すぐ ack して質問を遅らせない', () => {
  assertWords(`${HQ_SKILL} の手順7`, hqStep(7), [
    'heartbeat の一言',
    'すぐ ack',
    '質問を遅らせない',
    'ログのペイン',
    '#402',
    'hq-heartbeat.json',
  ]);
});

test('hq の手順12：人がすることの一覧に、heartbeat の一言から今の状況を載せる', () => {
  assertWords(`${HQ_SKILL} の手順12`, hqStep(12), ['今の状況', 'heartbeat の一言']);
});
