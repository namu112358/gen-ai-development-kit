// Issue #186：ship・fleet の SKILL.md に、出来事の控え（agent.ts incident）を振り分けて「改善の候補」を示す手順があること。
// 振り分けの手順は「人がすること」の手順の直前（ship は 9.→10.、fleet は 8.→9.）で、incident list・render-issue と既存の Issue の検索を使い、
// 人が選んだものだけを起票し（自動で起票しない）、ラベルは Jev に任せる。人に返す前にも振り分ける。render-comment は skill から使わない。
// 文言は固定しすぎず、語の有無で確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const SKILLS = [
  { name: 'ship', path: '.claude/skills/ship/SKILL.md', triage: 9, humanTodo: 10 },
  { name: 'fleet', path: '.claude/skills/fleet/SKILL.md', triage: 8, humanTodo: 9 },
] as const;

/** 見出しの行（完全一致）から、同じか上の階層の次の見出しの前までを切り出す */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `「${heading}」の節がありません`);
  const level = heading.match(/^#+/)![0].length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => {
    const m = l.match(/^(#+) /);
    return m !== null && m[1]!.length <= level;
  });
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** 節の中の、行頭の番号付きの手順（入れ子の行を含む）を番号ごとに */
function steps(text: string): Map<number, string> {
  const out = new Map<number, string>();
  let current: number | null = null;
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+)\. /);
    if (m) {
      current = Number(m[1]);
      out.set(current, line);
    } else if (current !== null) {
      out.set(current, `${out.get(current)}\n${line}`);
    }
  }
  return out;
}

function assertWords(where: string, text: string, words: string[]): void {
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `${where} に次の語句がありません：${missing.join('、')}`);
}

for (const skill of SKILLS) {
  const procedure = (): Map<number, string> => steps(section(read(skill.path), '## 手順'));

  test(`${skill.name}：「人がすること」の手順は ${skill.humanTodo}.、振り分けの手順はその直前の ${skill.triage}.`, () => {
    const s = procedure();
    const todo = [...s].filter(([, t]) => t.split('\n')[0]!.includes('**人がすること**')).map(([n]) => n);
    assert.deepEqual(todo, [skill.humanTodo], `**人がすること** の手順の番号`);
    const triage = [...s].filter(([, t]) => t.split('\n')[0]!.includes('振り分け')).map(([n]) => n);
    assert.ok(triage.includes(skill.triage), `振り分けの手順（${skill.triage}.）がありません（振り分けを含む手順：${triage.join('・')}）`);
    assert.ok(skill.triage < skill.humanTodo);
  });

  test(`${skill.name}：振り分けの手順は incident list・incident render-issue・既存の Issue の検索を使う`, () => {
    const t = procedure().get(skill.triage) ?? '';
    assertWords(`${skill.name} の手順${skill.triage}`, t, [
      'node harness/scripts/agent.ts incident list',
      'node harness/scripts/agent.ts incident render-issue',
      'gh issue list --state open --search',
    ]);
  });

  test(`${skill.name}：「改善の候補」の項があり、人が選んだものだけを起票し（自動で起票しない）、ラベルは Jev に任せる`, () => {
    const s = procedure();
    const text = `${s.get(skill.triage) ?? ''}\n${s.get(skill.humanTodo) ?? ''}`;
    assertWords(`${skill.name} の手順${skill.triage}・${skill.humanTodo}`, text, ['改善の候補', '人が選んだものだけ', '自動で起票しない', 'Jev']);
  });

  test(`${skill.name}：「人に返す条件」に、振り分けて改善の候補を示してから返す文がある`, () => {
    const sub = section(read(skill.path), '## 人に返す条件');
    assert.ok(
      sub.split('\n').some((l) => l.includes('振り分け') && l.includes('改善の候補')),
      `${skill.name} の「人に返す条件」に「振り分け」と「改善の候補」を含む行がありません`,
    );
  });

  test(`${skill.name}：skill からは agent.ts incident render-comment を使わない`, () => {
    assert.ok(!read(skill.path).includes('agent.ts incident render-comment'));
  });
}
