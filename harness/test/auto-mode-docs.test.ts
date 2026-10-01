// Issue #348：auto mode が docs（risk-policy・security の受け入れているリスク・glossary・formats・operations）に書かれている。
// 文言は固定せず、コードの定数（ラベル名・App の記録の kind）と見出し・表の構造で確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AUTO_MODE_MERGE_END_KIND, AUTO_MODE_MERGE_KIND, AUTO_MODE_SWITCH_KIND } from '../gates/auto-mode.ts';
import { AUTO_MODE_LABEL_DEFAULT } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

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

/** 表の行（`|` で始まる行）を、セルの配列にして返す（区切りの行は除く） */
function tableRows(text: string): { line: string; cells: string[] }[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|\s*-+\s*\|/.test(l))
    .map((line) => ({ line, cells: line.split('|').slice(1, -1).map((c) => c.trim()) }));
}

/** 1行の中に words がこの順で出るか */
function inOrder(line: string, words: string[]): boolean {
  let at = 0;
  for (const w of words) {
    const i = line.indexOf(w, at);
    if (i < 0) return false;
    at = i + w.length;
  }
  return true;
}

test('risk-policy.md の ## auto mode の節に、ラベル・Jev の設定・乗り方の順番・agent/tests の扱いがある', () => {
  const text = read('docs/risk-policy.md');
  const headings = text.split('\n').filter((l) => l.trim() === '## auto mode');
  assert.equal(headings.length, 1, '## auto mode の見出しがちょうど1つでない');
  const body = section(text, '## auto mode');
  for (const w of [AUTO_MODE_LABEL_DEFAULT, 'JEV_API_KEY', 'jev.mode', 'autoMode.jev.dangerSafe']) {
    assert.ok(body.includes(w), `## auto mode の節に「${w}」が無い`);
  }
  assert.ok(
    body.split('\n').some((l) => inOrder(l, ['委任', 'auto mode', 'bypass'])),
    '## auto mode の節に、委任 → auto mode → bypass の順に並ぶ行が無い',
  );
  assert.ok(
    body.split('\n').some((l) => l.startsWith('### agent/tests の扱い')),
    '## auto mode の節に ### agent/tests の扱い が無い',
  );
});

test('security.md の受け入れているリスクに、auto mode のラベルの行と Jev だけで判定する行がある', () => {
  const body = section(read('docs/security.md'), '## 受け入れているリスク');
  assert.ok(body !== '', '## 受け入れているリスク の節が無い');
  const rows = tableRows(body).filter((r) => (r.cells[0] ?? '').includes('auto mode'));
  assert.ok(
    rows.some((r) => r.cells[0] === 'auto mode のテストの判定の材料'),
    '既存の「auto mode のテストの判定の材料」の行が無い',
  );
  const others = rows.filter((r) => r.cells[0] !== 'auto mode のテストの判定の材料');
  assert.equal(others.length, 2, `1列目に auto mode を含む行が、既存の行のほかに2行でない（${others.length} 行）`);
  const labelRow = others.findIndex((r) => r.line.includes(AUTO_MODE_LABEL_DEFAULT));
  assert.ok(labelRow >= 0, `auto mode の行に ${AUTO_MODE_LABEL_DEFAULT} を含む行が無い`);
  const jevRow = others.findIndex((r, i) => i !== labelRow && r.line.includes('Jev') && r.line.includes('Claude'));
  assert.ok(jevRow >= 0, 'auto mode の行に Jev と Claude の両方を含む行（ラベルの行とは別）が無い');
});

test('glossary.md に ### auto mode の見出しがある', () => {
  const text = read('docs/glossary.md');
  assert.ok(
    text.split('\n').some((l) => l.startsWith('### auto mode')),
    'glossary.md に ### auto mode の見出しが無い',
  );
});

test('formats.md の App の記録の表に auto mode の kind があり、plan-gate と acceptance に autoMode がある', () => {
  const body = section(read('docs/formats.md'), '## App の記録（agent-app）');
  assert.ok(body !== '', '## App の記録（agent-app） の節が無い');
  const rows = tableRows(body);
  for (const kind of [AUTO_MODE_MERGE_KIND, AUTO_MODE_MERGE_END_KIND, AUTO_MODE_SWITCH_KIND]) {
    assert.ok(
      rows.some((r) => r.line.includes(`\`${kind}\``)),
      `App の記録の表に \`${kind}\` が無い`,
    );
  }
  for (const kind of ['plan-gate', 'acceptance']) {
    const row = rows.find((r) => r.cells[0] === `\`${kind}\``);
    assert.ok(row, `App の記録の表に \`${kind}\` の行が無い`);
    assert.ok(row.line.includes('autoMode'), `\`${kind}\` の行に autoMode が無い`);
  }
});

test('operations.md の auto mode の行に、未実装（子課題で足す・まだ見ない）の書き方が残っていない', () => {
  const rows = tableRows(read('docs/operations.md')).filter(
    (r) => (r.cells[0] ?? '').includes(AUTO_MODE_LABEL_DEFAULT) || /^auto mode を(始める|見返す|終える)/.test(r.cells[0] ?? ''),
  );
  const firsts = rows.map((r) => r.cells[0]);
  assert.ok(firsts.some((c) => c!.includes(AUTO_MODE_LABEL_DEFAULT)), `operations.md に ${AUTO_MODE_LABEL_DEFAULT} の行が無い`);
  for (const action of ['始める', '見返す', '終える']) {
    assert.ok(firsts.some((c) => c!.startsWith(`auto mode を${action}`)), `operations.md に「auto mode を${action}」の行が無い`);
  }
  for (const r of rows) {
    assert.ok(!r.line.includes('子課題で足す'), `operations.md の「${r.cells[0]}」の行に「子課題で足す」が残っている`);
    assert.ok(!r.line.includes('まだ auto mode を見ない'), `operations.md の「${r.cells[0]}」の行に「まだ auto mode を見ない」が残っている`);
  }
});
