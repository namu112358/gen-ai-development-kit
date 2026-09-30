// Issue #326：docs の照合（observe-docs）。実在しないサブコマンド・パス・ラベル・設定キー・リンク先・見出しが根拠（ファイル・行・名前）つきで出て、実在するもの・コードブロック・例・導入先のパス・接頭辞だけの書き方・値は出ないことを確かめる。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  agentSubcommands, buildDocsInventory, checkDoc, configKeyPaths, configTypeKeyNames, isDocTarget, markdownAnchors,
  type DocFinding, type DocsInventory,
} from '../lib/observe-docs.ts';
import { config } from './support/gate-fixtures.ts';

// --- 手で組んだ棚卸し ---

const FILES = [
  'README.md',
  'CLAUDE.md',
  'harness.config.json',
  'docs/setup.md',
  'docs/risk-policy.md',
  'docs/guide.md',
  'harness/lib/scope.ts',
  'harness/lib/config.ts',
  'harness/scripts/agent.ts',
  'harness/test/README.md',
  'harness/test/scope.test.ts',
  '.claude/skills/ship/SKILL.md',
];

const ANCHORS: Record<string, string[]> = {
  'docs/setup.md': ['はじめに', '8-プラグイン全員に同じ版で入れる'],
  'docs/risk-policy.md': ['委任承認'],
  'docs/guide.md': ['使い方', '自分の見出し'],
};

function inventory(patch: Partial<DocsInventory> = {}): DocsInventory {
  return {
    files: new Set(FILES),
    topLevel: new Set(FILES.map((f) => f.split('/')[0]!)),
    subcommands: new Set(['claim', 'release', 'worktree', 'render-plan', 'render-block']),
    labels: new Set(['agent:plan-ok', 'agent:hold', 'priority:high', 'area:harness']),
    labelPrefixes: ['agent:', 'priority:', 'area:'],
    configKeys: new Set(['appSlug', 'classification', 'classification.areas', 'classification.sizeExclude', 'fleet', 'fleet.nesting', 'routine', 'routine.maxItemsPerRun']),
    configKeyNames: new Set(['appSlug', 'classification', 'areas', 'sizeExclude', 'fleet', 'nesting', 'maxParallelShips', 'routine', 'maxItemsPerRun']),
    anchorsOf: (file) => (ANCHORS[file] ? new Set(ANCHORS[file]) : null),
    ...patch,
  };
}

const DOC = 'docs/guide.md';
const check = (lines: string[], file = DOC): DocFinding[] => checkDoc(file, lines.join('\n'), inventory());
const ofKind = (findings: DocFinding[], kind: DocFinding['kind']): DocFinding[] => findings.filter((f) => f.kind === kind);

// --- isDocTarget ---

test('isDocTarget：docs・skill・agent・routine・CLAUDE・README を対象にし、docs/upstream とコードは対象にしない', () => {
  for (const f of ['docs/setup.md', 'docs/sub/a.md', '.claude/skills/ship/SKILL.md', '.claude/agents/reviewer.md', '.claude/routine.md', 'CLAUDE.md', 'harness/CLAUDE.harness.md', 'README.md', 'harness/lib/README.md', 'harness/test/README.md']) {
    assert.equal(isDocTarget(f), true, `${f} を対象にしませんでした`);
  }
  for (const f of ['docs/upstream/x.md', 'harness/lib/scope.ts', 'docs/image.png', 'src/README.txt', 'harness.config.json']) {
    assert.equal(isDocTarget(f), false, `${f} を対象にしました`);
  }
});

// --- subcommand ---

test('checkDoc：agent.ts の実在しないサブコマンドを、ファイル・行・名前つきで出す', () => {
  const findings = check([
    '# 使い方',
    '',
    '`node harness/scripts/agent.ts claim 5 --manual` で宣言する。',
    '`node harness/scripts/agent.ts no-such-cmd 5` は無い。',
  ]);
  assert.deepEqual(findings, [{ kind: 'subcommand', name: 'no-such-cmd', file: DOC, line: 4 }]);
});

test('checkDoc：`agent.ts` の後にバッククォートを挟んだ書き方も読み、`render-*` は render- で始まるものがあれば出さない', () => {
  const findings = ofKind(check([
    '`agent.ts` `render-*` で本文を作る。',
    '`agent.ts` `bogus` は無い。',
  ]), 'subcommand');
  assert.deepEqual(findings, [{ kind: 'subcommand', name: 'bogus', file: DOC, line: 2 }]);
});

// --- path ---

test('checkDoc：最初の階層が実在するのにファイルが無いパスを出す（行番号の付いた書き方は外して見る）', () => {
  const findings = check([
    '`harness/lib/scope.ts` と `harness/lib/scope.ts:16` はある。',
    '`harness/lib/gone.ts` は無い。',
    '`harness/lib/lost.ts:12` も無い。',
  ]);
  assert.deepEqual(findings, [
    { kind: 'path', name: 'harness/lib/gone.ts', file: DOC, line: 2 },
    { kind: 'path', name: 'harness/lib/lost.ts', file: DOC, line: 3 },
  ]);
});

test('checkDoc：glob はどれかのファイルに当たるか、/ で終わる語はその下にファイルがあるかで見る', () => {
  const findings = ofKind(check([
    '`harness/test/**` と `docs/*.md` と `harness/lib/` はある。',
    '`harness/nope/**` は当たらない。',
    '`docs/upstream/` は無い。',
  ]), 'path');
  assert.deepEqual(findings.map((f) => [f.name, f.line]), [['harness/nope/**', 2], ['docs/upstream/', 3]]);
});

test('checkDoc：導入先のパス・<…> の例・… を含む語・最初の階層が無い語は見ない', () => {
  const findings = check([
    '`src/app.ts` は導入先のもの。',
    '`harness/lib/<名前>.ts` は例。',
    '`harness/lib/…` も例。',
    '`harness/{lib,test}/x.ts` も例。',
    '`npm run check` を通す。',
  ]);
  assert.deepEqual(findings, []);
});

test('checkDoc：コードブロック（``` と ~~~）の中は何も見ない', () => {
  const findings = check([
    '```sh',
    'node harness/scripts/agent.ts no-such-cmd',
    '`harness/lib/gone.ts` `agent:no-such`',
    '```',
    '~~~',
    '[x](missing.md)',
    '~~~',
    '`harness/lib/gone2.ts`',
  ]);
  assert.deepEqual(findings, [{ kind: 'path', name: 'harness/lib/gone2.ts', file: DOC, line: 8 }]);
});

test('checkDoc：```` の中の ``` では閉じず、開きと同じ記号・同じ長さ以上で後ろに何も無い行で閉じる', () => {
  const findings = check([
    '````markdown',
    '```agent-plan',
    '`harness/lib/gone.ts`',
    '```',
    '`harness/lib/gone.ts` はまだ中。',
    '~~~~',
    '`harness/lib/gone.ts` もまだ中。',
    '````',
    '`harness/lib/gone2.ts`',
  ]);
  assert.deepEqual(findings, [{ kind: 'path', name: 'harness/lib/gone2.ts', file: DOC, line: 9 }]);
});

// --- label ---

test('checkDoc：管理する接頭辞の実在しないラベルを出し、接頭辞だけの書き方・例・ほかの接頭辞は出さない', () => {
  const findings = check([
    '`agent:plan-ok` を App が付ける。',
    '`agent:no-such` は無い。',
    '`priority:*` と `area:<名前>` は書き方。',
    '`jev:foo` は管理しない接頭辞。',
  ]);
  assert.deepEqual(findings, [{ kind: 'label', name: 'agent:no-such', file: DOC, line: 2 }]);
});

// --- config-key ---

test('checkDoc：harness.config.json を含む行で、実在しない設定キーを出す', () => {
  const findings = check([
    '`harness.config.json` の `fleet.nesting` を `orca` にする。',
    '`harness.config.json` の `fleet.maxParallel` は無い。',
    '`harness.config.json` の `unknownKey` も無い。',
  ]);
  assert.deepEqual(findings, [
    { kind: 'config-key', name: 'fleet.maxParallel', file: DOC, line: 2 },
    { kind: 'config-key', name: 'unknownKey', file: DOC, line: 3 },
  ]);
});

test('checkDoc：道筋の末尾・型に書かれた名前は実在とみなし、「の」の後に並ばない値・harness.config.json の無い行は見ない', () => {
  const findings = check([
    '`harness.config.json` の `sizeExclude` と `areas`・`maxItemsPerRun`、`fleet`。',
    '`harness.config.json` の `maxParallelShips` は型に書かれている。',
    '`harness.config.json` の `fleet.nesting` は `orca` か `flat`。',
    '`harness.config.json` と `harness/lib/config.ts` はファイル名。',
    '`fooBar` は harness の設定の行ではない。',
  ]);
  assert.deepEqual(findings, []);
});

test('checkDoc：「harness.config.json の」に続けて ・ 、 , と や で並んだ語は1語でも見て、同じ行のほかの語は見ない', () => {
  const findings = check([
    '`harness.config.json` の `fleet.nesting`・`fleet.bogusKey` を見る。',
    '`harness.config.json` の `bogus` は無い。`needsHuman` と `orca` はこの形でない。',
  ]);
  assert.deepEqual(findings, [
    { kind: 'config-key', name: 'fleet.bogusKey', file: DOC, line: 1 },
    { kind: 'config-key', name: 'bogus', file: DOC, line: 2 },
  ]);
});

// --- link・anchor ---

test('checkDoc：リンク先のファイルが無ければ link、見出しが無ければ anchor で出す', () => {
  const findings = check([
    '# 使い方',
    '[setup](setup.md) と [scope](../harness/lib/scope.ts) と [lib](../harness/lib/) はある。',
    '[missing](missing.md) は無い。',
    '[見出し](setup.md#8-プラグイン全員に同じ版で入れる) はある。',
    '[見出し](setup.md#無い見出し) は無い。',
    '[外](https://example.com/none.md) と [メール](mailto:a@example.com) は見ない。',
    '`[code](gone.md)` はインラインコード。',
  ]);
  assert.deepEqual(findings, [
    { kind: 'link', name: 'missing.md', file: DOC, line: 3 },
    { kind: 'anchor', name: 'setup.md#無い見出し', file: DOC, line: 5 },
  ]);
});

test('checkDoc：# だけのリンクは同じファイルの見出しと照らす', () => {
  const findings = check([
    '# 使い方',
    '## 自分の見出し',
    '[上](#自分の見出し) はある。',
    '[無い](#無い見出し) は無い。',
  ]);
  assert.deepEqual(findings, [{ kind: 'anchor', name: '#無い見出し', file: DOC, line: 4 }]);
});

test('checkDoc：ルートのファイルからのリンクはルートからの相対で解決する', () => {
  const findings = check(['[risk](docs/risk-policy.md#委任承認) と [x](docs/none.md)'], 'README.md');
  assert.deepEqual(findings, [{ kind: 'link', name: 'docs/none.md', file: 'README.md', line: 1 }]);
});

test('checkDoc：出す順は行の順', () => {
  const findings = check([
    '[missing](missing.md)',
    '`agent:no-such`',
    '`node harness/scripts/agent.ts no-such-cmd`',
  ]);
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3]);
});

// --- markdownAnchors ---

test('markdownAnchors：GitHub と同じ規則で、日本語の見出しの記号を消し、空白を - にする', () => {
  const anchors = markdownAnchors(['# Hello World', '## 8. プラグイン（全員に同じ版で入れる）', '### 委任承認', '#### a_b-c'].join('\n'));
  for (const a of ['hello-world', '8-プラグイン全員に同じ版で入れる', '委任承認', 'a_b-c']) assert.ok(anchors.has(a), `${a} がありません：${[...anchors].join(', ')}`);
});

test('markdownAnchors：同じ名前の見出しは -1, -2 を付ける', () => {
  const anchors = markdownAnchors(['## 例', '## 例', '## 例'].join('\n'));
  assert.deepEqual([...anchors].sort(), ['例', '例-1', '例-2']);
});

test('markdownAnchors：コードブロックの中の # 行は見出しにせず、<a id> と name も含める', () => {
  const anchors = markdownAnchors(['```sh', '# コメント', '```', '<a id="custom-id"></a>', '<a name="old-name"></a>', '## 本物'].join('\n'));
  assert.ok(!anchors.has('コメント'));
  assert.ok(anchors.has('custom-id'));
  assert.ok(anchors.has('old-name'));
  assert.ok(anchors.has('本物'));
});

test('markdownAnchors：```` の中の ``` では閉じず、その間の # 行は見出しにしない', () => {
  const anchors = markdownAnchors(['````markdown', '```agent-plan', '```', '# 中の見出し', '````', '## 外の見出し'].join('\n'));
  assert.ok(!anchors.has('中の見出し'));
  assert.ok(anchors.has('外の見出し'));
});

// --- agentSubcommands・configKeyPaths・configTypeKeyNames ---

const AGENT_SOURCE = [
  "  if (cmd === 'worktree') {",
  "  if (cmd === 'worktree' || cmd === 'worktree-remove') {",
  "  if (cmd === 'render-plan') return void console.log(1);",
  '  switch (cmd) {',
  "    case 'queue': return void 0;",
  "    case 'claim': return claim();",
  "    case 'claim': return claim();",
].join('\n');

test('agentSubcommands：case と cmd === の名前を重複なく読む', () => {
  assert.deepEqual(agentSubcommands(AGENT_SOURCE).sort(), ['claim', 'queue', 'render-plan', 'worktree', 'worktree-remove']);
});

test('configKeyPaths：ネストを . でつなぎ、途中の道筋も含め、配列の中と $ で始まるキーは見ない', () => {
  const paths = configKeyPaths({ $comment: 'x', a: 1, b: { c: 1, d: { e: 2 } }, arr: [{ x: 1 }] });
  assert.deepEqual(paths.sort(), ['a', 'arr', 'b', 'b.c', 'b.d', 'b.d.e']);
});

test('configTypeKeyNames：HarnessConfig の中のキー名（ネストも、? 付きも）を読み、ほかの interface は読まない', () => {
  const source = [
    'export interface Other { notConfig: string }',
    'export interface HarnessConfig {',
    '  appSlug: string;',
    '  classification: {',
    '    sizeExclude: string[];',
    '  };',
    '  requireAssignee?: boolean;',
    '  fleet?: { nesting?: string; maxParallelShips?: number };',
    '}',
    'export interface After { afterKey: number }',
  ].join('\n');
  const names = new Set(configTypeKeyNames(source));
  for (const n of ['appSlug', 'classification', 'sizeExclude', 'requireAssignee', 'fleet', 'nesting', 'maxParallelShips']) assert.ok(names.has(n), `${n} がありません`);
  assert.ok(!names.has('notConfig'));
  assert.ok(!names.has('afterKey'));
});

// --- buildDocsInventory ---

test('buildDocsInventory：ファイルの一覧・readText の中身から棚卸しを作り、読めない Markdown の見出しは null', () => {
  const texts: Record<string, string> = {
    'harness/scripts/agent.ts': AGENT_SOURCE,
    'harness/lib/config.ts': 'export interface HarnessConfig {\n  appSlug: string;\n  maxParallelShips?: number;\n}\n',
    'harness.config.json': JSON.stringify(config),
    'docs/setup.md': '# はじめに\n\n## 8. プラグイン（全員に同じ版で入れる）\n',
  };
  const files = ['README.md', 'docs/setup.md', 'docs/gone.md', 'harness/scripts/agent.ts', 'harness/lib/config.ts', 'harness.config.json', '.claude/routine.md'];
  const inv = buildDocsInventory({ files, readText: (p) => texts[p] ?? null, config });
  assert.ok(inv.files.has('docs/setup.md'));
  for (const t of ['README.md', 'docs', 'harness', 'harness.config.json', '.claude']) assert.ok(inv.topLevel.has(t), `topLevel に ${t} がありません`);
  assert.ok(inv.subcommands.has('claim'));
  assert.ok(inv.subcommands.has('worktree-remove'));
  assert.ok(inv.labelPrefixes.includes('agent:'));
  assert.ok(inv.configKeys.has('routine.maxItemsPerRun'));
  assert.ok(inv.configKeyNames.has('maxParallelShips'));
  assert.ok(inv.anchorsOf('docs/setup.md')?.has('8-プラグイン全員に同じ版で入れる'));
  assert.equal(inv.anchorsOf('docs/gone.md'), null);
});
