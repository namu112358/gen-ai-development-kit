// Issue #235：Jev の確度が下限未満で付かなかった priority:*・area:* は、付き添いのセッションが判断して付けてよい。
// 規則（harness/CLAUDE.harness.md）・ship・fleet の skill・docs/operations.md・overview.html に、付けてよい範囲と、
// 付けたら理由を Issue のコメントに残すこと、label-triage の記録が無いうちは付けないこと、人や App のラベル・保護ラベル・違反は変えないことが
// 書かれているかと、label-triage のコメント（renderLabelTriage）の文言がこの扱いと合っているかを確かめる
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderLabelTriage, type JevLabelResult } from '../gates/label-apply.ts';
import type { TriageSummary } from '../lib/issue-triage.ts';

const root = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

/** 見出し（`## 名前` など）から、同じか上の階層の次の見出しの前までを返す。見出しが無ければ失敗させる */
function section(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimEnd() === heading);
  assert.ok(start >= 0, `見出し「${heading}」が無い`);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(/^(#+) /);
    if (m && (m[1] ?? '').length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/** 段落・箇条・表の行ごとに分けた、空でない行 */
const nonEmptyLines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

/** 番号付きの手順（`8. ` など）の行と、その字下げした続きの行を返す。手順が無ければ失敗させる */
function step(text: string, n: number): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${n}. `));
  assert.ok(start >= 0, `手順${n}が無い`);
  const out = [lines[start] ?? ''];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/^\s+\S/.test(l)) out.push(l);
    else break;
  }
  return out.join('\n');
}

// ---- 規則（進め方）の Jev の箇条 ----

const rulesText = (): string => read('harness/CLAUDE.harness.md');
const jevRule = (): string => {
  const line = nonEmptyLines(section(rulesText(), '## 進め方')).find((l) => l.includes('Jev') && l.includes('priority:*'));
  assert.ok(line, '`Jev` と `priority:*` を同じ箇条に書いた行が規則に無い');
  return line;
};

test('規則（進め方）：label-triage の記録で下限未満だったものは、セッションが決めて付けてよい', () => {
  const line = jevRule();
  assert.match(line, /label-triage/, '材料にする `label-triage` の記録が書かれていない');
  assert.match(line, /下限未満/, '下限未満のものが対象であることが書かれていない');
  assert.match(line, /セッション/, 'セッションが付けることが書かれていない');
  assert.match(line, /(決め|判断し)て?付けてよい/, 'セッションが決めて付けてよいことが書かれていない');
  assert.match(line, /本文/, 'Issue の本文を見て決めることが書かれていない');
  assert.match(line, /提案/, 'Jev の提案を見て決めることが書かれていない');
});

test('規則（進め方）：付けたら、付けたラベルと理由を Issue のコメントに残す', () => {
  const line = jevRule();
  assert.match(line, /理由/, '理由を残すことが書かれていない');
  assert.match(line, /コメントに(残|書)/, '理由を Issue のコメントに残すことが書かれていない');
});

test('規則（進め方）：label-triage の記録が無いうちは付けない（推測で付けない）', () => {
  assert.match(jevRule(), /記録が無い(うち|とき|間|Issue)[^。]*付け(ない|ず)/, '記録が無いうちは付けないことが書かれていない');
});

test('規則（進め方）：材料にするのは App の名義（appSlug）の記録だけ', () => {
  const line = jevRule();
  assert.match(line, /appSlug/, '記録の名義を `appSlug` で見分けることが書かれていない');
  assert.match(line, /名義/, 'App の名義の記録だけを材料にすることが書かれていない');
});

test('規則（進め方）：付けてよいのは priority:*・area:* だけで、人や App が付けたラベル・type:*・違反は変えない', () => {
  const line = jevRule();
  assert.match(line, /area:\*/, '`area:*` が書かれていない');
  assert.match(line, /area:\*`?\s*(だけ|のみ)/, '付けてよいのが `priority:*`・`area:*` だけであることが書かれていない');
  assert.match(line, /人や App が付けた|人・App が付けた|人か App が付けた/, '人や App が付けたラベルを変えないことが書かれていない');
  assert.match(line, /type:\*/, '`type:*` を変えないことが書かれていない');
  assert.match(line, /違反/, '違反を変えないことが書かれていない');
  assert.match(line, /変え(ない|ず)/, '変えないことが書かれていない');
  for (const label of ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped', 'agent:delegate-merge', 'review:exempt', 'test:exempt']) {
    assert.ok(!line.includes(label), `Jev の箇条に \`${label}\` が付けてよいものとして入っている`);
  }
  assert.doesNotMatch(line, /:exempt/, 'Jev の箇条に `*:exempt` が入っている');
});

test('規則（進め方）：ラベルの不足を人に聞かず、伝えない（#213 のまま）', () => {
  const line = jevRule();
  assert.match(line, /聞か(ない|ず)/, '人に聞かないことが書かれていない');
  assert.match(line, /伝え(ない|ず)/, '人に伝えないことが書かれていない');
});

test('規則（やってはいけないこと）：保護ラベルの付け外しが今どおり残っている', () => {
  const lines = nonEmptyLines(section(rulesText(), '## やってはいけないこと'));
  const line = lines.find((l) => l.includes('agent:plan-ok'));
  assert.ok(line, '「やってはいけないこと」に `agent:plan-ok` の行が無い');
  assert.match(line, /agent:hold/, '`agent:hold` が無い');
  assert.match(line, /agent:auto-merge-stopped/, '`agent:auto-merge-stopped` が無い');
  assert.match(line, /付け外し/, '付け外しをしないことが書かれていない');
});

// ---- ship の手順8・fleet の手順6 ----

const skillSteps: Array<[string, number]> = [
  ['.claude/skills/ship/SKILL.md', 8],
  ['.claude/skills/fleet/SKILL.md', 6],
];

for (const [path, n] of skillSteps) {
  test(`${path} の手順${n}：label-triage の notApplied を材料に、決めて付け、理由をコメントに残す`, () => {
    const text = step(read(path), n);
    assert.match(text, /priority:\*/, '`priority:*` が無い');
    assert.match(text, /area:\*/, '`area:*` が無い');
    assert.match(text, /label-triage/, '`label-triage` の記録を読むことが書かれていない');
    assert.match(text, /notApplied/, '`notApplied` を読むことが書かれていない');
    assert.match(text, /付け/, '足りないものを付けることが書かれていない');
    assert.match(text, /コメントに(残|書)/, '理由をコメントに残すことが書かれていない');
  });

  test(`${path} の手順${n}：記録が無ければ付けず、一覧にも書かず、人にも聞かない`, () => {
    const text = step(read(path), n);
    assert.match(text, /記録が無(い|けれ)[^。]*付け(ない|ず)/, '記録が無ければ付けないことが書かれていない');
    assert.match(text, /一覧に(も)?書か(ない|ず)/, '一覧に書かないことが書かれていない');
    assert.match(text, /聞か(ない|ず)/, '人に聞かないことが書かれていない');
    assert.doesNotMatch(text, /agent\.ts label-audit/, 'label-audit を走らせる手順がある');
  });
}

// ---- docs/operations.md ----

const labelApply = (): string => section(read('docs/operations.md'), '#### 足りないラベルを付ける');

test('operations.md「足りないラベルを付ける」：セッションが下限未満のものを決めて付け、理由をコメントに残す', () => {
  const line = nonEmptyLines(labelApply()).find((l) => l.includes('セッション') && l.includes('下限未満'));
  assert.ok(line, 'セッションが下限未満のものを扱うことを書いた行が無い');
  assert.match(line, /(決め|判断し)て?付け/, 'セッションが決めて付けることが書かれていない');
  assert.match(line, /理由/, '理由を残すことが書かれていない');
  assert.match(line, /コメント/, '理由をコメントに残すことが書かれていない');
  assert.match(line, /記録が無い(うち|とき|間|Issue)[^。]*付け(ない|ず)/, '記録が無いうちは付けないことが書かれていない');
});

test('operations.md「足りないラベルを付ける」：無条件の「推測で付けない」の古い文が無い', () => {
  const found = nonEmptyLines(labelApply()).filter((l) => /推測で付け(ない|ず)/.test(l) && !/記録が無い/.test(l));
  assert.deepEqual(found, [], `記録が無いうちに限らない「推測で付けない」が残っている：${found.join(' / ')}`);
});

// ---- overview.html ----

test('overview.html：priority:* の付ける者は「人 / App / Claude」、area:* は「App / Claude」', () => {
  const html = read('overview.html');
  const row = (label: string): string => {
    const r = html.split('\n').find((l) => l.includes(`<tr><td><code>${label}</code></td>`));
    assert.ok(r, `overview.html に \`${label}\` の行が無い`);
    return r;
  };
  assert.match(row('priority:*'), /data-k="付ける者">人 \/ App \/ Claude</, '`priority:*` の付ける者が「人 / App / Claude」でない');
  assert.match(row('area:*'), /data-k="付ける者">App \/ Claude</, '`area:*` の付ける者が「App / Claude」でない');
});

// ---- label-triage のコメントの文言 ----

test('renderLabelTriage：付けなかったものは「付き添いのセッションか人が付けてください」と書く', () => {
  const summary: TriageSummary = { type: ['feat', 0.9], area: ['docs', 0.4], priority: ['high', 0.5], acVerifiable: 0.9, requirementsClear: 0.9, warnings: [] };
  const results: JevLabelResult[] = [
    { question: 'priority', choice: 'high', probability: 0.5, label: 'priority:high', applied: false, reason: '確率 50% が下限 80% 未満' },
    { question: 'area', choice: 'docs', probability: 0.4, label: 'area:docs', applied: false, reason: '確率 40% が下限 80% 未満' },
  ];
  const body = renderLabelTriage(summary, results);
  assert.ok(body.includes('付けなかったもの（付き添いのセッションか人が付けてください）:'), `付けなかったものの見出しが新しい文言でない：\n${body}`);
  assert.ok(!body.includes('付けなかったもの（人が付けてください）'), '古い「人が付けてください」が残っている');
});
