// skill（.claude/skills/*/SKILL.md と references/*.md）と担当の定義（.claude/agents/*.md）のうち、言い換えると動かなくなるものだけを確かめる。
// 残す基準（Issue #1007）：
//   1. Claude Code が実行時に読む文：skill の frontmatter（name がディレクトリ名と同じ・description）、agent の frontmatter（name がファイル名と同じ・tools）
//   2. 文書に書いた名前の実在：skill に書いた agent.ts のコマンドと、panes.ts・patrol.ts・qa-retro-loop.ts・test-prune-loop.ts のサブコマンドが、各スクリプトの使い方のコメントにある
//   3. コードが名前で指す見出し・語・ファイル名：harness-drift が指す交代の見出し、hq のコードが読む語、.gitignore の .agent-harness-workspace
// 地の文の語の有無だけを見る検査（構造の表 SHIP_SPEC など、CLAUDE.md・docs・担当の定義の文言、素の orca の書き方）は #1007 で消した。
// 元は skills・fleet-skill・hq-skill・patrol-skill・arch-review-skill・intel-skill・qa-retro-skill・issue-creator-skill・stack-docs の各テスト。
// CLAUDE.md の @ の読み込み先の実在は managed-docs.test.ts が持つ。
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { frontmatter, readText, ROOT, skillText } from './support/skill-text.ts';

const skillPath = (name: string): string => `.claude/skills/${name}/SKILL.md`;
/** .claude/skills/ の下で SKILL.md を持つディレクトリ（orca-cli・orchestration の写しも含む） */
const SKILLS = readdirSync(join(ROOT, '.claude', 'skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
/** .claude/agents/ の担当の定義（README を除く） */
const AGENTS = readdirSync(join(ROOT, '.claude', 'agents')).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => f.slice(0, -3)).sort();
const HANDOFF = '## ハーネスが更新されたときの交代';

// ---- 基準1：Claude Code が実行時に読む frontmatter ----

test('全 skill：frontmatter の name がディレクトリ名と同じで、description がある', () => {
  assert.ok(SKILLS.includes('ship') && SKILLS.includes('orca-cli'), `skill の一覧を読めていません：${SKILLS.join(', ')}`);
  const problems: string[] = [];
  for (const name of SKILLS) {
    const fm = frontmatter(readText(skillPath(name)));
    if (fm.name !== name) problems.push(`${name}: name が ${fm.name ?? '(無し)'}`);
    if (!fm.description) problems.push(`${name}: description がありません`);
  }
  assert.deepEqual(problems, []);
});

test('全 agent：frontmatter の name がファイル名と同じで tools があり、plan-critic・arch-reviewer の tools はちょうど Read, Grep, Glob, Bash, Write', () => {
  assert.ok(AGENTS.includes('plan-critic') && AGENTS.includes('arch-reviewer'), `agent の一覧を読めていません：${AGENTS.join(', ')}`);
  const problems: string[] = [];
  for (const name of AGENTS) {
    const fm = frontmatter(readText(`.claude/agents/${name}.md`));
    if (fm.name !== name) problems.push(`${name}: name が ${fm.name ?? '(無し)'}`);
    if (!fm.tools) problems.push(`${name}: tools がありません`);
  }
  for (const name of ['plan-critic', 'arch-reviewer']) {
    const tools = frontmatter(readText(`.claude/agents/${name}.md`)).tools;
    if (tools !== 'Read, Grep, Glob, Bash, Write') problems.push(`${name}: tools が ${tools ?? '(無し)'}`);
  }
  assert.deepEqual(problems, []);
});

// ---- 基準2：文書に書いた名前の実在 ----

test('全 skill：本文（references も合わせ読み）に書いた agent.ts のコマンドは使い方のコメントに実在し、完全な形で書く', () => {
  const known = documentedAgentCommands();
  for (const c of ['judge-input', 'post-plan', 'fleet-status']) assert.ok(known.has(c), `使い方のコメントからコマンド ${c} を読めていません`);
  const problems: string[] = [];
  let total = 0;
  for (const name of SKILLS) {
    const text = skillText(skillPath(name));
    const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
    total += used.length;
    for (const cmd of used) if (!known.has(cmd)) problems.push(`${name}: agent.ts ${cmd} は使い方のコメントにありません`);
    // 完全な形（node harness/scripts/agent.ts <コマンド>）でない書き方があると、上の照合から漏れる
    const loose = text.split('agent.ts ').length - 1;
    if (loose !== used.length) problems.push(`${name}: agent.ts のコマンドは完全な形で書く（agent.ts の後が ${loose} 件、完全な形が ${used.length} 件）`);
  }
  // 正規表現が空回りしていないこと（gh-stack・review-panel・orca-cli・orchestration は0件でよい）
  assert.ok(total > 0, '全 skill を合わせて agent.ts のコマンドを1件も拾えていません');
  assert.deepEqual(problems, []);
});

/** スクリプトの先頭の使い方のコメント（最初の `/** … *\/`）の `node harness/scripts/<script> <サブコマンド>`。`a|b|c` は分けて数える */
function documentedSubcommands(script: string): Set<string> {
  const doc = readText(`harness/scripts/${script}`).match(/\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
  const re = new RegExp(`^\\s*\\*\\s+node harness/scripts/${script.replace(/\./g, '\\.')} ([a-z][\\w|-]*)`, 'gm');
  return new Set([...doc.matchAll(re)].flatMap((m) => m[1]!.split('|')));
}

/** 本文に書いた `<script> <サブコマンド>`（`node harness/scripts/` の有無を問わない） */
const usedSubcommands = (text: string, script: string): string[] =>
  [...text.matchAll(new RegExp(`(?<![\\w-])${script.replace(/\./g, '\\.')} ([a-z][\\w-]*)`, 'g'))].map((m) => m[1]!);

test('hq・patrol・qa-retro・test-prune の skill に書いた panes.ts・patrol.ts・qa-retro-loop.ts・test-prune-loop.ts のサブコマンドは、各スクリプトの使い方のコメントに実在する', () => {
  const texts = ['hq', 'patrol', 'qa-retro', 'test-prune'].map((name) => [name, skillText(skillPath(name))] as const);
  const problems: string[] = [];
  for (const script of ['panes.ts', 'patrol.ts', 'qa-retro-loop.ts', 'test-prune-loop.ts']) {
    const known = documentedSubcommands(script);
    assert.ok(known.size > 0, `${script} の使い方のコメントからサブコマンドを読めていません`);
    let total = 0;
    for (const [name, text] of texts) {
      const used = usedSubcommands(text, script);
      total += used.length;
      for (const sub of used) if (!known.has(sub)) problems.push(`${name}: ${script} ${sub} は使い方のコメントにありません`);
    }
    // 正規表現が空回りしていないこと（どのスクリプトも、4つの skill のどこかで使っている）
    assert.ok(total > 0, `4つの skill から ${script} のサブコマンドを1件も拾えていません`);
  }
  assert.deepEqual(problems, []);
});

// ---- 基準3：コードが名前で指す見出し・語・ファイル名 ----

// harness/lib/harness-drift.ts と harness/scripts/agent/commands/harness-drift.ts が、
// 「ハーネスが更新されたときの交代」の名前で ship の本文と fleet の見出しを指す
test('ハーネスが更新されたときの交代：harness-drift が名前で指す語が ship の本文と fleet の見出しにある', () => {
  assert.ok(readText('harness/lib/harness-drift.ts').includes('ハーネスが更新されたときの交代'), 'harness-drift.ts が交代の節を指していません');
  assert.ok(readText(skillPath('ship')).includes('ハーネスが更新されたときの交代'), 'ship の本文に「ハーネスが更新されたときの交代」がありません');
  assert.ok(readText(skillPath('fleet')).split('\n').includes(HANDOFF), `fleet に見出し「${HANDOFF}」がありません`);
});

test('hq の skill：コードが名前で読む語（hq-fleets.json・hq.maxFleets・.agent-harness-workspace）がある', () => {
  // hq-fleets.json：harness/lib/panes-hq.ts・harness/scripts/hq-state.ts・harness/scripts/panes.ts
  // hq.maxFleets：harness/lib/config.ts・harness/lib/hq-stall.ts・harness/lib/panes-hq.ts
  // .agent-harness-workspace：.claude/hooks/workspace-guard.ts
  const text = skillText(skillPath('hq'));
  const missing = ['hq-fleets.json', 'hq.maxFleets', '.agent-harness-workspace'].filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `hq の skill に次の語句がありません：${missing.join('、')}`);
});

// git が hq の印のファイル（fleet のワークスペースの .agent-harness-workspace）を無視する
test('.gitignore に .agent-harness-workspace がある', () => {
  const lines = readText('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('.agent-harness-workspace'), '.gitignore に .agent-harness-workspace の行がありません');
});
