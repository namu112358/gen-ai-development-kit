// hq の skill（.claude/skills/hq/SKILL.md）の文を、support/skill-text.ts の構造の表で確かめる（Issue #487 で hq-panes・hq-sweep・
// hq-heartbeat-status・hq-intel の skill のテストをここにまとめた。元は #287・#197・#402・#407・#425・#396・#432）。
// 表（HQ_SPEC・FLEET_FOR_HQ_SPEC）は1つの test() で、足りないものを全部一度に示す。frontmatter・コマンドの実在と書き方・
// コードが名前で読む語は個別の test() に、docs・設定の文の確かめはまとめずに残す。語句は要点ごとに少なく絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { frontmatter, readText, section, skillProblems, type SkillSpec } from './support/skill-text.ts';

const HQ_SKILL = '.claude/skills/hq/SKILL.md';
const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const AS_WORKER = '## Orca の worker として動くとき';
const skill = (): string => readText(HQ_SKILL);

/** hq の skill の構造の表 */
const HQ_SPEC: SkillSpec = {
  path: HQ_SKILL,
  headings: ['## 入力', '## 手順', '## 終わりの状態', '## 人に返す条件'],
  words: [
    // テーマの案 → 人の承認 → fleet の起動 → 人の判断をまとめて聞く → 片付け（#287）
    'テーマの案', '人の承認', 'AskUserQuestion', 'worker-start', 'new-top-level', 'question', 'reply', '答え無し', 'Epic が Close',
    // 起こし直しの条件と回数（#287）
    'exited', 'unverifiable', '1時間に2回', '人に知らせる', 'agent-harness:hq-restart', '--takeover',
    // プライマリで動く・書き換えない・進んでいない fleet・Orca が無い環境（#287）
    'isMainWorktree', '書き換えない', 'panes.ts fleets --session', 'Orca が無い',
  ],
  parts: [
    { section: '## 手順', order: ['テーマの案', 'worker-start', 'reply', 'Epic が Close'] },
    // 手順2：するのは…だけ（#407・#396）
    { step: 2, words: ['承認した案だけ', 'sub-issues', 'SendMessage', 'terminal create'] },
    // 手順4：fleet を起こす指示に heartbeat の一言（#425）
    { step: 4, words: ['heartbeat の本文に今の状況を一言入れる'] },
    // 手順6：ペインの並びと開き方。ペインにセッションを渡さない（#402・#430）
    {
      step: 6,
      words: ['ORCA terminal split', '--direction vertical', '--direction horizontal', '左', '右', 'intel', 'intel のペインを開かずに進める'],
      absent: ['--session'],
      order: ['node harness/scripts/panes.ts hq board', 'node harness/scripts/panes.ts hq todo', 'node harness/scripts/panes.ts hq log'],
    },
    { step: 6, order: ['Epic/Issue', '人待ち', 'ログ'] },
    // 手順7：heartbeat の一言をログのペインに使い、すぐ ack する（#425）
    { step: 7, words: ['heartbeat の一言', 'すぐ ack', '質問を遅らせない', 'ログのペイン', '#402', 'hq-heartbeat.json'] },
    // 手順8：止まったタスクの見回し（#407）
    {
      step: 8,
      words: [
        '進んでいない fleet を見つける', '止まったタスクの見回し', 'ダッシュボード', 'patrol', 'fleet-status',
        '担当のいない PR', '止まった宣言', 'どの fleet にも入っていない', 'Epic に入っていない', 'sub-issues',
        'send', 'hq.maxFleets', '人の承認', '引き継ぐかは人が決める', 'AskUserQuestion', '1回', 'intel', '承認した案だけ',
      ],
    },
    // 手順12：人がすることの一覧（#402・#407・#425・#396）
    {
      step: 12,
      words: ['panes.ts hq todo --once', '割り振ったもの', '案として聞いたもの', '人が決めなかったもの', '今の状況', 'heartbeat の一言', 'intel に回せなかった気づき'],
    },
    // 相談・アイデアを intel に回す（#396）
    {
      section: '## 相談・アイデアを intel に回す',
      words: [
        '人に上げる', 'intel に回す', '今すぐの判断が要らない', 'question', 'plan-review', 'SendMessage', 'to: intel',
        'intel のタブに直接送ってください', 'ListAgents', '既にいる', 'terminal create', '--title intel', '--name intel', 'auto mode', '手順12の一覧',
      ],
    },
  ],
};

/** hq と関わる fleet の skill の表（Orca の worker として動くとき） */
const FLEET_FOR_HQ_SPEC: SkillSpec = {
  path: FLEET_SKILL,
  parts: [
    // 4：intel への送信（#396）
    { section: AS_WORKER, step: 4, words: ['intel への送信'] },
    // 6：heartbeat の本文に今の状況を一言、質問は載せない（#425）
    {
      section: AS_WORKER,
      step: 6,
      words: ['heartbeat の本文に今の状況を一言入れる', '`--body`', 'Issue 番号・段階・次にすること・待っているもの', '#388 実装中、次は判定', 'heartbeat に質問を載せない'],
    },
    // 9：範囲の外の気づきを intel に送り、迷ったら hq に上げ、混ざるときは分ける（#396・#432。手順9の中だけを見る）
    {
      section: AS_WORKER,
      step: 9,
      words: ['範囲の外の気づき', 'SendMessage', 'to: intel', 'hq を通さず', 'worker_done', '迷ったら', 'hq に上げる', '混ざる', '分け'],
    },
  ],
};

// ---- 構造の表 ----

test('hq の skill の構造の表', () => {
  assert.deepEqual(skillProblems(HQ_SPEC), []);
});

test('hq と関わる fleet の skill の表（Orca の worker として動くとき）', () => {
  assert.deepEqual(skillProblems(FLEET_FOR_HQ_SPEC), []);
});

// ---- コードが名前で読む語 ----

test('hq の skill：コードが名前で読む語（hq-fleets.json・hq.maxFleets・.agent-harness-workspace）がある', () => {
  // hq-fleets.json：harness/lib/panes-hq.ts・harness/scripts/hq-state.ts・harness/scripts/panes.ts
  // hq.maxFleets：harness/lib/config.ts・harness/lib/hq-stall.ts・harness/lib/panes-hq.ts
  // .agent-harness-workspace：.claude/hooks/workspace-guard.ts
  const text = skill();
  const missing = ['hq-fleets.json', 'hq.maxFleets', '.agent-harness-workspace'].filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `hq の skill に次の語句がありません：${missing.join('、')}`);
});

// ---- 形（skills.test.ts の SKILLS に hq は入らないので、同じ検査をここで行う） ----

test('hq の skill：frontmatter の name が hq で、description がある', () => {
  const fm = frontmatter(skill());
  assert.equal(fm.name, 'hq');
  assert.ok(fm.description, 'description がありません');
});

// ---- 使うコマンドが実在する・書き方 ----

test('hq の skill：使う agent.ts のコマンドは使い方のコメントに実在し、完全な形で書かれている', () => {
  const known = documentedAgentCommands();
  assert.ok(known.has('fleet-status') && known.has('usage'), '使い方のコメントからコマンドを読めていません');
  const text = skill();
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0, 'agent.ts のコマンドがありません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形（node harness/scripts/agent.ts <コマンド>）で書く');
});

test('hq の skill：使う panes.ts のサブコマンドは panes.ts の先頭のコメントに実在する（fleets を含む）', () => {
  const header = readText('harness/scripts/panes.ts').match(/^\/\*\*[\s\S]*?\*\//)?.[0] ?? '';
  const known = new Set([...header.matchAll(/^\s*\*\s+node harness\/scripts\/panes\.ts ([a-z|]+)/gm)].flatMap((m) => m[1]!.split('|')));
  assert.ok(known.has('fleets'), 'panes.ts の先頭のコメントに fleets がありません');
  const used = [...skill().matchAll(/panes\.ts ([a-z]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0, 'panes.ts のサブコマンドがありません');
  for (const cmd of used) assert.ok(known.has(cmd), `panes.ts ${cmd} は panes.ts の先頭のコメントにありません`);
});

// スクリプトが Run・セッションで数えるため、書き方そのものを確かめる（#197：hq の Run で数える。古いスナップショットを数えない）
test('hq の skill：worker-start と worker-list に --run、node harness/scripts/panes.ts fleets に --session がある', () => {
  const text = skill();
  const blocks = [...text.matchAll(/```text\n([\s\S]*?)```/g)].flatMap((m) => m[1]!.split('\n')).map((l) => l.trim());
  const starts = blocks.filter((l) => l.includes('orchestration worker-start'));
  assert.ok(starts.length > 0, '```text のブロックに worker-start のコマンドがありません');
  assert.deepEqual(starts.filter((l) => !l.includes('--run ')), [], '--run の無い worker-start があります');

  const lists = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!).filter((s) => /\bworker-list\b/.test(s) && s.includes(' '));
  assert.ok(lists.length > 0, 'worker-list のコマンドがありません');
  assert.deepEqual(lists.filter((s) => !s.includes('--run ')), [], '--run の無い worker-list があります');

  const fleets = [...text.matchAll(/node harness\/scripts\/panes\.ts fleets([^\n]{0,12})/g)].map((m) => m[1]!);
  assert.ok(fleets.length > 0, 'node harness/scripts/panes.ts fleets がありません');
  assert.deepEqual(fleets.filter((rest) => !rest.startsWith(' --session')), [], '--session の無い node harness/scripts/panes.ts fleets があります');
});

// ---- docs・設定の文（まとめずに残す） ----

test('.gitignore に .agent-harness-workspace がある', () => {
  const lines = readText('.gitignore').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('.agent-harness-workspace'), '.gitignore に .agent-harness-workspace の行がありません');
});

test('harness/CLAUDE.harness.md の skill の表に hq の行がある', () => {
  assert.ok(readText('harness/CLAUDE.harness.md').includes('[hq](../.claude/skills/hq/SKILL.md)'), 'skill の表に hq の行がありません');
});

test('CLAUDE.md の構成の表の .claude/skills/ の行に hq がある', () => {
  const line = readText('CLAUDE.md').split('\n').find((l) => l.startsWith('| `.claude/skills/`'));
  assert.ok(line, '.claude/skills/ の行がありません');
  assert.match(line, /\bhq\b/, '.claude/skills/ の行に hq がありません');
});

test('.claude/skills/README.md の表に hq/ の行がある', () => {
  assert.ok(readText('.claude/skills/README.md').includes('| `hq/` |'), 'skill の README の表に hq/ の行がありません');
});

test('overview.html の skills/ の一覧に hq がある', () => {
  const line = readText('overview.html').split('\n').find((l) => l.includes('<code>skills/</code>'));
  assert.ok(line, 'overview.html に skills/ の行がありません');
  const list = line.match(/（([^）]*)）/)?.[1] ?? '';
  assert.ok(list.split('・').map((s) => s.trim()).includes('hq'), `skills/ の一覧（${list}）に hq がありません`);
});

test('docs/operations.md に hq の説明がある', () => {
  const text = readText('docs/operations.md');
  const missing = ['hq', 'isMainWorktree', '答え無し', 'exited'].filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `docs/operations.md に次の語句がありません：${missing.join('、')}`);
});

test('docs/operations.md に hq・fleet・panes の設定と既定値がある', () => {
  const lines = readText('docs/operations.md').split('\n');
  const defaults: [string, string][] = [
    ['hq.staleSnapshotMinutes', '30'],
    ['hq.stuckMinutes', '120'],
    ['hq.maxFleets', '2'],
    ['fleet.shipMode', 'subagent'],
    ['panes.collectIntervalSeconds', '180'],
  ];
  for (const [key, def] of defaults) {
    const hits = lines.filter((l) => l.includes(key));
    assert.ok(hits.length > 0, `docs/operations.md に ${key} がありません`);
    assert.ok(hits.some((l) => l.includes(def)), `docs/operations.md の ${key} の行に既定値 ${def} がありません`);
  }
});

test('docs/operations.md の hq の節（「fleet と hq の設定」の前まで）に、intel に回すことと intel のタブがある', () => {
  const lines = section(readText('docs/operations.md'), '### hq（テーマごとの fleet をまとめる）').split('\n');
  const end = lines.findIndex((l) => l.startsWith('fleet と hq の設定'));
  const text = (end < 0 ? lines : lines.slice(0, end)).join('\n');
  assert.ok(text !== '', 'docs/operations.md に「### hq（テーマごとの fleet をまとめる）」がありません');
  const missing = ['intel', '回す', 'intel のタブ'].filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `docs/operations.md の hq の節に次の語句がありません：${missing.join('、')}`);
});

test('overview.html の Claude（付き添いのセッション）の section に intel に回すがある', () => {
  const html = readText('overview.html');
  const h3 = html.indexOf('<h3>Claude（付き添いのセッション）</h3>');
  assert.ok(h3 >= 0, 'overview.html に <h3>Claude（付き添いのセッション）</h3> がありません');
  const start = html.lastIndexOf('<section', h3);
  assert.ok(start >= 0, 'overview.html の Claude（付き添いのセッション）を含む <section> がありません');
  const end = html.indexOf('</section>', h3);
  assert.ok(end > h3, 'overview.html の Claude（付き添いのセッション）の <section> が閉じていません');
  assert.ok(html.slice(start, end).includes('intel に回す'), 'overview.html の Claude（付き添いのセッション）の section に「intel に回す」がありません');
});
