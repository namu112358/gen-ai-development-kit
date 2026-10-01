// ship・plan・implement・judge・fix・sync の skill と、ship・plan と関わる fleet の skill の文を、support/skill-text.ts の構造の表で確かめる
// （Issue #489 で ship-skill・ship-fleet-handoff・plan-ask-before-post・plan-critic-output-file・incident-skills・label-delegation・
// ship-implement-model のテストをここにまとめた。元は #155・#186・#199・#209・#217・#289・#299・#469）。
// 表（SHIP_SPEC・PLAN_SPEC・IMPLEMENT_SPEC・JUDGE_SPEC・FIX_SPEC・SYNC_SPEC・FLEET_FOR_SHIP_SPEC）は表ごとに1つの test() で、足りないものを全部一度に示す。
// frontmatter・コマンドの実在と書き方・コードが名前で読む語・素の orca・CLAUDE.md・docs・plan-critic の定義は個別の test() に残す。
// fleet の skill そのものの表は fleet の skill のテスト（#488）が持ち、ここには ship・plan との受け渡しの語だけを置く。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { NO_OVERWRITE_RULE, WRITE_RULES } from './support/output-file-rules.ts';
import { frontmatter, readText, section, skillProblems, type SkillSpec } from './support/skill-text.ts';

const SKILLS = ['ship', 'plan', 'implement', 'judge', 'fix', 'sync', 'fleet'];
const HEADINGS = ['## 入力', '## 手順', '## 終わりの状態', '## 人に返す条件'];
const skillPath = (name: string): string => `.claude/skills/${name}/SKILL.md`;
const HANDOFF = '## ハーネスが更新されたときの交代';
const TRIAGE_WORDS = [
  '振り分け', 'node harness/scripts/agent.ts incident list', 'node harness/scripts/agent.ts incident render-issue',
  'gh issue list --state open --search', '人が選んだものだけ', '自動で起票しない', 'Jev',
];

/** 箇条（- か「数字.」で始まる行と、その下の続きの行）ごとに分ける */
const bullets = (text: string): string[] => text.split(/\n(?=\s*(?:-|\d+\.) )/);

/** バッククォートのコード（インラインの `…` と、``` で囲んだブロックの各行）を取り出す */
function codeSpans(text: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) out.push(...m[1]!.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  const inline = text.replace(fence, '');
  for (const m of inline.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!.trim());
  return out;
}

/** ship の skill の構造の表 */
const SHIP_SPEC: SkillSpec = {
  path: skillPath('ship'),
  headings: HEADINGS,
  words: [
    // plan → implement → judge → fix → sync をつなぐ（#155）
    'plan の skill', 'implement の skill', 'judge の skill', 'fix の skill', 'sync の skill',
    // 古いセッションの交代（#199）
    'harness-drift', '/fleet <自分の Issue 番号>', 'release <番号>', 'judge は古いセッションで始めない',
  ],
  parts: [
    // 出来事の控えの振り分けと人がすること（#186・#209）
    { section: '## 手順', step: 9, words: TRIAGE_WORDS },
    { section: '## 手順', step: 10, words: ['**人がすること**', '改善の候補'], absent: ['ラベルの不足'] },
    // 入れ子の ship は自分では交代せず、投稿の前の質問は投稿せずに fleet に返す（#199・#299）
    {
      section: '## サブエージェントの ship として動くとき',
      words: ['待つ（読み込みが古い）', '自分では交代しない', '投稿の前', '投稿せず', 'fleet に返す', '選択肢', 'パス', '呼び直され', '書き込', '除', '批評'],
      absent: ['止まらない', '申告を残して投稿し、聞くこと'],
    },
    { section: '## 人に返す条件', words: ['振り分け', '改善の候補', '古い', 'judge', '交代を拒まれた'] },
    // fleet から起こされた ship は implementModel で実装だけを動かす（#469）
    {
      section: '## 実装のモデル（fleet から起こされた ship）',
      words: ['panes.ts config', 'implementModel', 'model', 'test-designer', '--stage plan', '実装のモデル:', '変えないもの', 'plan-critic', 'judge'],
    },
    { absent: ['agent.ts incident render-comment', 'agent.ts label-audit'] },
  ],
};

/** plan の skill の構造の表 */
const PLAN_SPEC: SkillSpec = {
  path: skillPath('plan'),
  headings: HEADINGS,
  parts: [
    // 手順3：投稿の前に openQuestions・needsHumanReasons を聞き、答えを計画に書き込む（#289・#299）
    {
      section: '## 手順',
      step: 3,
      words: [
        'openQuestions', 'needsHumanReasons', 'AskUserQuestion', '本文', '除', '答えなかった', '拒んだ', '残して投稿', '批評に渡す',
        'Routine', '聞かない', '投稿せず', '呼び直され', 'acChangeProposed', '今までどおり',
      ],
    },
    // plan-critic が出力のパスに書く（#217）
    { section: '## 手順', step: 5, words: ['critic-input', '--previous', 'critic-<番号>-'] },
    {
      section: '## 手順',
      step: 6,
      words: [
        'critic-<番号>-<回数>.json', '出力のパス', '呼ぶ前', 'ファイルが無い', '回数を進め', '1 に戻さない', 'JSON として読める', '代わりに書かない',
        '同じパス', '1回だけ', '呼び直', 'git status --porcelain --untracked-files=all', '呼んだ後', '比べる',
      ],
    },
    { section: '## 手順', step: 7, words: ['食い違', 'ファイルの中身を使う'] },
    { section: '## 手順', step: 8, words: ['post-plan'] },
    { section: '## 手順', order: ['openQuestions', 'critic-input', 'post-plan'] },
    { section: '## 人に返す条件', words: ['JSON として読めない'] },
    { absent: ['保存', '-retry', 'が空'] },
  ],
};

const IMPLEMENT_SPEC: SkillSpec = { path: skillPath('implement'), headings: HEADINGS };
const JUDGE_SPEC: SkillSpec = { path: skillPath('judge'), headings: HEADINGS };
const FIX_SPEC: SkillSpec = { path: skillPath('fix'), headings: HEADINGS };
const SYNC_SPEC: SkillSpec = { path: skillPath('sync'), headings: HEADINGS };

/** ship・plan と関わる fleet の skill の表（交代・入れ子の質問・振り分け・ラベル）。fleet の skill そのものの表は fleet-skill.test.ts */
const FLEET_FOR_SHIP_SPEC: SkillSpec = {
  path: skillPath('fleet'),
  headings: HEADINGS,
  parts: [
    // ハーネスが更新されたときの交代（#199）
    {
      section: HANDOFF,
      words: [
        'このセッションの読み込みは古い', 'node harness/scripts/agent.ts harness-drift', 'fleet-status', 'release <番号>', '段階の切れ目',
        '段階の途中では交代しない', '新しい段階', '始めない', '古いセッションでは始めない', 'claim --stage judge', 'step',
        'AskUserQuestion', '交代しますか', '拒まれた', '1行', 'orca-cli', 'Resolve the CLI', 'terminal create', 'claude --permission-mode auto "/fleet',
        '--git-common-dir', 'git -C <本体> pull --ff-only', 'できなければ起動せず', 'auto mode', '確かめられない', '引き継ぎの要約',
        'Orca が無い', '/fleet <番号…>', 'pull --ff-only', 'claude --permission-mode auto',
      ],
    },
    // 入れ子の ship の投稿の前の質問（#299）
    { section: '## 入れ子の方式', words: ['投稿の前', 'AskUserQuestion', '呼び直す', 'release <番号>'] },
    // 出来事の控えの振り分けと人がすること（#186・#209）
    { section: '## 手順', step: 8, words: TRIAGE_WORDS },
    { section: '## 手順', step: 9, words: ['**人がすること**', '改善の候補'], absent: ['ラベルの不足'] },
    { section: '## 人に返す条件', words: ['振り分け', '改善の候補', '交代を拒まれた', 'auto mode'] },
    { absent: ['申告を残して投稿して質問を返す', 'agent.ts incident render-comment', 'agent.ts label-audit'] },
  ],
};

for (const [name, spec] of Object.entries({ SHIP_SPEC, PLAN_SPEC, IMPLEMENT_SPEC, JUDGE_SPEC, FIX_SPEC, SYNC_SPEC, FLEET_FOR_SHIP_SPEC })) {
  test(`${name} の構造の表`, () => assert.deepEqual(skillProblems(spec), []));
}

test('frontmatter の name がディレクトリ名と同じで、description がある', () => {
  for (const name of SKILLS) {
    const fm = frontmatter(readText(skillPath(name)));
    assert.equal(fm.name, name, `${name}: name`);
    assert.ok(fm.description, `${name}: description がありません`);
  }
});

test('skill が使う agent.ts のコマンドは、使い方のコメントに実在し、完全な形で書く', () => {
  const known = documentedAgentCommands();
  for (const c of ['judge-input', 'post-plan', 'show-plan', 'worktree-remove']) assert.ok(known.has(c), `使い方のコメントからコマンド ${c} を読めていません`);
  for (const name of SKILLS) {
    const text = readText(skillPath(name));
    const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
    assert.ok(used.length > 0, `${name}: agent.ts のコマンドがありません`);
    for (const cmd of used) assert.ok(known.has(cmd), `${name}: agent.ts ${cmd} は使い方のコメントにありません`);
    // 完全な形（node harness/scripts/agent.ts <コマンド>）でない書き方があると、上の照合から漏れる
    assert.equal(text.split('agent.ts ').length - 1, used.length, `${name}: agent.ts のコマンドは完全な形で書く`);
  }
});

// コードが名前で読む語：harness/lib/harness-drift.ts と harness/scripts/agent/commands/harness-drift.ts が、
// 「ハーネスが更新されたときの交代」の名前で ship の本文と fleet の見出しを指す
test('ハーネスが更新されたときの交代：harness-drift が名前で指す語が ship の本文と fleet の見出しにある', () => {
  assert.ok(readText('harness/lib/harness-drift.ts').includes('ハーネスが更新されたときの交代'), 'harness-drift.ts が交代の節を指していません');
  assert.ok(readText(skillPath('ship')).includes('ハーネスが更新されたときの交代'), 'ship の本文に「ハーネスが更新されたときの交代」がありません');
  assert.ok(readText(skillPath('fleet')).split('\n').includes(HANDOFF), `fleet に見出し「${HANDOFF}」がありません`);
});

test('fleet・ship の SKILL.md に、素の orca で始まるコマンドが無い', () => {
  for (const name of ['fleet', 'ship']) {
    // orca-skills.test.ts の bareOrcaUses と同じ見方：`orca …` はコマンド、`orca` 単独は語として許す
    const bare = codeSpans(readText(skillPath(name))).filter((c) => /^orca\s/.test(c));
    assert.deepEqual(bare, [], `${name} に素の orca のコマンドがあります`);
  }
});

/** CLAUDE.md と、それが読み込むハーネスの規則（harness/CLAUDE.harness.md、Issue #155）を合わせた本文 */
const claudeMd = (): string => ['CLAUDE.md', 'harness/CLAUDE.harness.md'].map(readText).join('\n');

test('CLAUDE.md が ship と5つの skill を案内する', () => {
  const text = claudeMd();
  assert.match(text, /Issue を進めるときは ship を使う/);
  for (const name of ['ship', 'plan', 'implement', 'judge', 'fix', 'sync']) assert.ok(text.includes(`(../.claude/skills/${name}/SKILL.md)`), `${name} への案内がありません`);
  assert.match(text, /\| `\.claude\/skills\/` \|/);
});

test('CLAUDE.md は Routine を将来の構想としている', () => {
  const routineLine = claudeMd().split('\n').find((l) => l.includes('.claude/routine.md') && l.includes('Routine'));
  assert.ok(routineLine, 'Routine の行がありません');
  assert.match(routineLine, /将来の構想/);
});

test('harness/CLAUDE.harness.md：進め方の投稿の前に聞く箇条が、既存の AskUserQuestion の箇条より後にあり、入れ子の ship は投稿せずに fleet に返すと書く', () => {
  const rules = readText('harness/CLAUDE.harness.md');
  const start = rules.indexOf('## 進め方');
  const end = rules.indexOf('## 立場');
  assert.ok(start >= 0 && end > start, '「## 進め方」「## 立場」がありません');
  const items = bullets(rules.slice(start, end));
  const existing = items.findIndex((b) => b.includes('AskUserQuestion') && b.includes('選択肢') && b.includes('4問'));
  assert.ok(existing >= 0, '「選択肢」「4問」を含む既存の AskUserQuestion の箇条がありません');
  const added = items.findIndex((b, i) => i !== existing && b.includes('投稿の前') && b.includes('openQuestions') && b.includes('AskUserQuestion'));
  assert.ok(added >= 0, '進め方に「投稿の前」・openQuestions・AskUserQuestion を含む箇条がありません');
  assert.ok(added > existing, '投稿の前に聞く箇条が、既存の AskUserQuestion の箇条より前にあります');
  for (const w of ['入れ子', '投稿せず', 'fleet']) assert.ok(items[added]!.includes(w), `投稿の前に聞く箇条に「${w}」がありません`);
});

// ---- plan-critic の定義（#217） ----

const CRITIC = '.claude/agents/plan-critic.md';

test('plan-critic の定義：tools はちょうど Read, Grep, Glob, Bash, Write で、WebFetch・MCP が無い', () => {
  const fm = frontmatter(readText(CRITIC));
  assert.equal(fm.name, 'plan-critic');
  assert.equal(fm.tools, 'Read, Grep, Glob, Bash, Write');
  assert.ok(!/WebFetch|WebSearch|mcp/i.test(fm.tools ?? ''), '外に出るツールが無い');
});

test('plan-critic の定義：判定の担当と同じ言い回しで、渡された出力のパスに Write で書く文がある', () => {
  const text = readText(CRITIC);
  for (const rule of WRITE_RULES) assert.ok(text.includes(rule), `「${rule}」がありません`);
});

test('plan-critic の定義：判定の担当と同じ言い回しで、渡されたパスにファイルが既にあれば上書きしない文がある', () => {
  assert.ok(readText(CRITIC).includes(NO_OVERWRITE_RULE), '既にあるファイルを上書きしない文がありません');
});

test('plan-critic の定義：「## 入力」に出力のパスがある', () => {
  const input = section(readText(CRITIC), '## 入力');
  assert.ok(input !== '', '「## 入力」がありません');
  assert.ok(input.includes('出力のパス'), '「## 入力」に出力のパスがありません');
});

test('plan-critic の定義：「リポジトリのファイルを変更しない」があり、素の「ファイルを変更しない。」が残っていない', () => {
  const text = readText(CRITIC);
  assert.ok(text.includes('リポジトリのファイルを変更しない'), '「リポジトリのファイルを変更しない」がありません');
  const bare = text.split('リポジトリのファイルを変更しない').join('');
  assert.ok(!bare.includes('ファイルを変更しない。'), 'Write と食い違う素の「ファイルを変更しない。」が残っています');
});

// ---- docs（#209） ----

test('docs/operations.md「足りないラベルを付ける」：セッションは聞かず Jev に任せ、人がすることの一覧に書く古い文が無い', () => {
  const sub = section(readText('docs/operations.md'), '#### 足りないラベルを付ける');
  assert.ok(sub !== '', '見出し「#### 足りないラベルを付ける」がありません');
  const line = sub.split('\n').find((l) => l.includes('セッション') && /聞か(ない|ず)/.test(l));
  assert.ok(line, 'セッションがラベルの不足を人に聞かないことを書いた行がありません');
  assert.match(line, /Jev/, 'その行に、Jev に任せることが書かれていません');
  assert.doesNotMatch(sub, /人がすることの一覧に書く/, '「人がすることの一覧に書く」が残っています');
});
