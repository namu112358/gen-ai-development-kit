// fleet の skill（.claude/skills/fleet/SKILL.md）の文を、support/skill-text.ts の構造の表で確かめる（Issue #488 で fleet-orca・fleet-worker・
// fleet-panes-skill・fleet-watch-skill・fleet-hq-report・orca-split-direction-skill の6本をここにまとめた。元は #197・#285・#415・#430・#199・#395）。
// 表（FLEET_SPEC・HQ_FOR_FLEET_SPEC・SHIP_FOR_FLEET_SPEC）は1つずつの test() で、足りないものを全部一度に示す。コードが名前で読む語・
// コマンドの実在と書き方は個別の test() に、docs・設定の文の確かめはまとめずに残す。語句は要点ごとに少なく絞り、文言を丸ごと固定しない。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { documentedAgentCommands } from './support/agent-source.ts';
import { readText, section, skillProblems, type SkillSpec } from './support/skill-text.ts';

const FLEET_SKILL = '.claude/skills/fleet/SKILL.md';
const SHIP_SKILL = '.claude/skills/ship/SKILL.md';
const HQ_SKILL = '.claude/skills/hq/SKILL.md';
const SHIP_WORKER = '## Orca の worker で ship を動かすとき';
const AS_WORKER = '## Orca の worker として動くとき';
const WATCH = '## 待つ間の読み直し';
const OPERATIONS = 'docs/operations.md';
const HQ_HEADING = '### hq（テーマごとの fleet をまとめる）';
const VERTICAL_IS_LEFT_RIGHT = /vertical`?\s*で左右/;

/** バッククォートのコード（インラインの `…` と、``` で囲んだブロックの各行）を取り出す */
function codeSpans(text: string): string[] {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  for (const m of text.matchAll(fence)) out.push(...m[1]!.split('\n').map((l) => l.trim()).filter((l) => l !== ''));
  const inline = text.replace(fence, '');
  for (const m of inline.matchAll(/`([^`\n]+)`/g)) out.push(m[1]!.trim());
  return out;
}

/** fleet の skill の構造の表 */
const FLEET_SPEC: SkillSpec = {
  path: FLEET_SKILL,
  headings: ['## 手順', '## 入れ子の方式（orca）'],
  parts: [
    // 節の順番（#197・#285）
    { order: ['## 入れ子の方式（orca）', SHIP_WORKER, AS_WORKER, '## 終わりの状態'] },
    // 入力：受け持つ Epic（#199）
    { section: '## 入力', words: ['--epic <Epic番号>', 'parseChildMarker', '複数', 'Epic は無い', '/fleet --epic <Epic番号> <番号…>'] },
    // 手順：hq を使わないときの手順に ask も worker_done も出てこない（#285）。手順1：/clear の後の宣言を1問で聞く（#199）。手順5：待つ間の読み直しへ
    { section: '## 手順', absent: ['orchestration ask', 'worker_done'] },
    { section: '## 手順', step: 1, words: ['/clear', '1問', '1件ずつ', '--takeover', 'AskUserQuestion'] },
    { section: '## 手順', step: 5, words: ['待つ間の読み直し'] },
    { section: '## 入れ子の方式（orca）', absent: ['orchestration ask', 'worker_done'] },
    { section: '## 入れ子の方式（orca）', step: 3, words: ['待つ間の読み直し'] },
    // ship を worker で動かす節（#197）
    {
      section: SHIP_WORKER,
      words: [
        'ORCA orchestration worker-start', 'worker_done', 'node harness/scripts/agent.ts fleet-status', '読み直',
        '状態の正は GitHub', '判断の正はラベル', 'decision gate', '正にしない',
        '入口の skill', '優先', '`ORCA open`', '試さない',
        '領域の上限', '`--fleet`', 'ほかのセッションの宣言で止まったら', '--outcome failed',
        'ORCA orchestration run-create',
      ],
    },
    {
      section: SHIP_WORKER,
      step: 1,
      words: ['node harness/scripts/panes.ts config', 'shipMode', '`worker`', 'ORCA status', 'ORCA skills get orchestration', '失敗', 'Orca が無い', '今の手順', '「手順」', '入れ子の方式（orca）'],
    },
    { section: SHIP_WORKER, step: 3, words: ['次にやること', '段階', 'settle していない Dispatch が無い', '同時に動かす ship は'] },
    {
      section: SHIP_WORKER,
      step: 4,
      words: ['claude --permission-mode auto', 'ORCA terminal read', 'auto mode', 'bypass', '起こさず'],
      order: ['node harness/scripts/agent.ts claim', 'node harness/scripts/agent.ts worktree', 'node harness/scripts/agent.ts release', 'ORCA orchestration worker-start'],
    },
    // 手順6：束の中の heartbeat はすぐ ack し、question などを後回しにしない（#395）
    { section: SHIP_WORKER, step: 6, words: ['heartbeat', '--ack', 'すぐ', '後回しにしない', 'question'] },
    // 手順7：起動に失敗したら出し直さず今の手順に戻る。hq に起こされた fleet は入れ子の方式に戻るか escalation で止める（#197）
    {
      section: SHIP_WORKER,
      step: 7,
      words: ['worker-start', '0 以外', '今の手順', '出し直さ', 'hq に起こされた fleet', '入れ子の方式に戻る', '入れ子にできなければ', 'escalation', '止める'],
    },
    // worker として動く節（#285・#415・#430・#395・#199）
    {
      section: AS_WORKER,
      words: [
        'orchestration ask', '--resume', 'reply', 'AskUserQuestion を使わず', 'worker_done', 'release <番号>',
        'terminal split', 'terminal send', 'panes.ts collect', 'panes.ts todo', 'panes.ts prs', 'terminal close', '空のシェルのペイン',
        'node harness/scripts/panes.ts config', '`worker`', '`subagent`', 'Orca の worker で ship を動かすとき',
        '書き換えない', 'Issue の worktree の中でだけ',
        '--type status', 'ready-<PR>', 'merged-<PR>', 'verdict-<PR>', 'wait-<Issue>', 'notice',
      ],
      absent: ['まだ無い', '3回分けて', '4ペイン'],
    },
    // 手順3：ペインの並びと作り方。向きは Orca 1.4.216 の実際の動き（#415・#430）
    {
      section: AS_WORKER,
      step: 3,
      words: [
        '左に fleet の Claude（縦いっぱい）', 'ORCA terminal split', '--direction vertical', '--direction horizontal',
        'panes.ts todo', 'panes.ts collect', 'panes.ts prs',
        '1.4.216', '案内', '逆', '`--direction vertical` で左右', '--include-visual-layouts', '違えば', '分け直す',
        '対象の Issue が変わったら', '--interrupt', '作り方',
      ],
      absent: ['逆なら', 'ORCA skills get orchestration', '進み具合のペインを閉じ、'],
      order: ['左に fleet の Claude', '右に上から', '進み具合', 'あなたがすること', 'PR と費用'],
    },
    { section: AS_WORKER, step: 3, order: ['- 作り方', '--direction vertical', '右が進み具合', '下があなたがすること', '下が PR と費用'] },
    { section: AS_WORKER, step: 4, words: ['node harness/scripts/agent.ts worktree', 'worker-start', 'Orca の worker で ship を動かすとき'] },
    // 手順6：heartbeat は前置きの間隔より短く送らず、status の直後に重ねない（#395）
    { section: AS_WORKER, step: 6, words: ['heartbeat', '前置きの間隔より短い間隔で送らない', '`status`', '重ねて送らない'] },
    // 手順7：終わるとき。閉じる handle の確かめ、答えを待つ Issue があるうちは worker_done しない（#415・#395・#199）
    {
      section: AS_WORKER,
      step: 7,
      words: [
        '閉じる handle', 'fleet 自身の Claude', '確かめ', '同じなら閉じない',
        '答えを待っている', '`worker_done` を送らない', 'ask --resume', 'release <番号>', 'レポート', 'message_id',
        'worker_done', '受け持つ Epic', 'check', '人の判断待ちだけが残',
      ],
    },
    // 手順8：status の送り方・時機・相談は ask・二重に送らない控え（#395）
    {
      section: AS_WORKER,
      step: 8,
      words: ['ORCA orchestration send', '--type status', '--subject', '送る時機', 'ship が返ったとき', 'fleet-status', '相談', '`ask`', 'fleet-hq-sent.json', '人の判断が要るものは `status` で送らない'],
    },
    // 待つ間の読み直し（#199）
    {
      section: WATCH,
      words: [
        'node harness/scripts/agent.ts fleet-status --watch', 'human-merge', 'auto-merge', '手順9', '間隔',
        'run_in_background', 'Monitor', 'schedule', 'Actions', 'Routine', '使わない',
        'このセッションの読み込みは古い', 'ハーネスが更新されたときの交代',
        'plan-ok', 'Merge 後の見届けが済んでいない', '呼び直', 'sync', 'fleet 自身は衝突を直さない', 'ほかのセッション',
        'Close されていない', '見張りの記録には残さない', '最初の1回だけ', '人の判断待ちに数える', '呼び直さない',
        'App が動いていない', 'escalation', '1回だけ',
        'gh issue view <Epic番号> --json state', 'Merge 済み', '人の判断待ちだけが残',
      ],
    },
    { section: '## ハーネスが更新されたときの交代', words: ['/fleet --epic <Epic番号> <番号…>'] },
    { section: '## 終わりの状態', words: ['受け持つ Epic', 'Close', '人の判断待ちだけが残'] },
    { section: '## 人に返す条件', words: ['人の判断待ちだけが残', '読み直し」を続ける'], absent: ['- 選んだ Issue が全部待つ状態になった\n'] },
  ],
};

/** fleet と関わる hq の skill の表 */
const HQ_FOR_FLEET_SPEC: SkillSpec = {
  path: HQ_SKILL,
  parts: [
    // 手順7：status の待ち・heartbeat を先に ack・振り分け（#395）
    {
      step: 7,
      words: [
        '--types "worker_done,escalation,question,status"', 'heartbeat', 'すぐ `--ack <delivery_id>`', '後回しにしない',
        'ready-<PR>', 'notice', 'merged-<PR>', 'verdict-<PR>', 'wait-<Issue>',
        'dispatch_inactive', '人に聞き直さない', '手順12', 'gh pr list', '仮の見張り', '置かない',
      ],
      order: ['すぐ伝える', 'ready-<PR>', '手順12の一覧にためる', 'merged-<PR>'],
      absent: ['届いたものを全部処理してから'],
    },
    // 手順6：Orca 1.4.216 の向きと、分けた後の確かめ（#430）
    {
      step: 6,
      words: ['1.4.216', '案内', '逆', '`--direction vertical` で左右', '--include-visual-layouts', '違えば', '分け直す'],
      absent: ['逆なら', 'ORCA skills get orchestration'],
    },
  ],
};

/** fleet と関わる ship の skill の表 */
const SHIP_FOR_FLEET_SPEC: SkillSpec = {
  path: SHIP_SKILL,
  words: ['worktree-remove', 'gh issue view <番号> --json state', '何度呼ばれても', 'Validation Requirements', 'npm run check'],
  parts: [
    // Merge 済みで呼び直されたとき・/clear の後の宣言を1問で聞く（#199）
    {
      section: '## 手順',
      step: 1,
      words: ['Merge 済み', 'worktree-remove', 'gh issue view <番号> --json state', '/clear', '1問', '1件ずつ', '--takeover', 'AskUserQuestion'],
    },
    { section: '## サブエージェントの ship として動くとき', words: ['Merge 済み', '呼び直', '返すもの', 'Merge 後の見届け済み', 'Close されていない'] },
  ],
};

// ---- 構造の表 ----

test('fleet の skill の構造の表', () => {
  assert.deepEqual(skillProblems(FLEET_SPEC), []);
});

test('fleet と関わる hq の skill の表（手順7の status の待ちと手順6のペインの向き）', () => {
  assert.deepEqual(skillProblems(HQ_FOR_FLEET_SPEC), []);
});

test('fleet と関わる ship の skill の表（Merge 済みで呼び直されたとき・返すもの・/clear の後の1問）', () => {
  assert.deepEqual(skillProblems(SHIP_FOR_FLEET_SPEC), []);
});

// ---- コードが出す・名前で読む語 ----

test('fleet の skill：コードが出す・名前で読む語がある', () => {
  // このセッションの読み込みは古い：harness/lib/harness-drift.ts
  // Merge 後の見届けが済んでいない・App が動いていない・待つ間の読み直し：harness/lib/fleet-watch.ts・harness/scripts/agent/commands/fleet-status.ts
  // 同時に動かす ship は：harness/lib/fleet.ts
  // parseChildMarker：harness/lib/epic.ts
  const text = readText(FLEET_SKILL);
  const words = ['このセッションの読み込みは古い', 'Merge 後の見届けが済んでいない', 'App が動いていない', '待つ間の読み直し', '同時に動かす ship は', 'parseChildMarker'];
  const missing = words.filter((w) => !text.includes(w));
  assert.deepEqual(missing, [], `fleet の skill に次の語句がありません：${missing.join('、')}`);
});

// ---- 使うコマンドが実在する・書き方 ----

test('fleet の skill：agent.ts のコマンドは使い方のコメントに実在し完全な形で書かれ、ship を worker で動かす節では引数つきのコマンドも node harness/scripts/agent.ts で始まる', () => {
  const known = documentedAgentCommands();
  assert.ok(known.has('claim') && known.has('fleet-status'), '使い方のコメントからコマンドを読めていません');
  const text = readText(FLEET_SKILL);
  const used = [...text.matchAll(/node harness\/scripts\/agent\.ts ([^\s`]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0, 'agent.ts のコマンドがありません');
  for (const cmd of used) assert.ok(known.has(cmd), `agent.ts ${cmd} は使い方のコメントにありません`);
  assert.equal(text.split('agent.ts ').length - 1, used.length, 'agent.ts のコマンドは完全な形（node harness/scripts/agent.ts <コマンド>）で書く');
  // check は Orca の orchestration のサブコマンドと同じ名前なので除く
  const names = new Set([...known].filter((c) => c !== 'check'));
  const bare = codeSpans(section(text, SHIP_WORKER)).filter((s) => {
    const [first, ...args] = s.split(/\s+/);
    return names.has(first!) && args.length > 0;
  });
  assert.deepEqual(bare, [], `完全な形でない agent.ts のコマンドがあります：${bare.join('、')}`);
});

test('fleet の skill：素の orca で始まるコードが無く、ship を worker で動かす節と worker として動く節に ORCA で始まる形がある', () => {
  const text = readText(FLEET_SKILL);
  const bare = codeSpans(text).filter((s) => /^orca\s/.test(s));
  assert.deepEqual(bare, [], `素の「orca 」で始まるコードがあります：${bare.join('、')}`);
  for (const heading of [SHIP_WORKER, AS_WORKER]) {
    assert.ok(codeSpans(section(text, heading)).some((s) => s.startsWith('ORCA ')), `「${heading}」の節に「ORCA 」で始まるコードがありません`);
  }
});

// スクリプトが Run で数えるため、書き方そのものを確かめる（#197）
test('fleet の skill：ship の worker の worker-start・worker-list・check のコマンドには fleet の Run の --run を付ける', () => {
  const cmds = codeSpans(section(readText(FLEET_SKILL), SHIP_WORKER)).filter((s) => /^ORCA orchestration (worker-start|worker-list|check)\b/.test(s));
  assert.ok(cmds.some((s) => s.startsWith('ORCA orchestration worker-start')), 'worker-start のコマンドがありません');
  const noRun = cmds.filter((s) => !s.includes('--run '));
  assert.deepEqual(noRun, [], `--run の無いコマンドがあります：${noRun.join('、')}`);
});

// ---- docs・設定の文（まとめずに残す） ----

test('docs/operations.md：hq の節に、fleet のワークスペースのペインが 左に fleet の Claude、右に上から 進み具合（collect）→ あなたがすること（todo）→ PR と費用（prs）の並びで書かれている', () => {
  const sub = section(readText(OPERATIONS), HQ_HEADING);
  assert.ok(sub !== '', `docs/operations.md に「${HQ_HEADING}」の節がありません`);
  const line = sub.split('\n').find((l) => {
    if (!l.includes('左に fleet の Claude')) return false;
    const right = l.indexOf('右に上から');
    if (right < 0 || right < l.indexOf('左に fleet の Claude')) return false;
    let at = right;
    for (const w of ['進み具合', 'panes.ts collect', 'あなたがすること', 'panes.ts todo', 'PR と費用', 'panes.ts prs']) {
      const i = l.indexOf(w, at);
      if (i < 0) return false;
      at = i + w.length;
    }
    return true;
  });
  assert.ok(line, 'hq の節に「左に fleet の Claude … 右に上から 進み具合（panes.ts collect）→ あなたがすること（panes.ts todo）→ PR と費用（panes.ts prs）」の順の文がありません');
  assert.ok(line.includes('fleet のワークスペースのペイン'), '並びの文に「fleet のワークスペースのペイン」がありません');
});

test('docs/operations.md：hq の節に、fleet 自身の Claude の端末は閉じないことが書かれている', () => {
  const sub = section(readText(OPERATIONS), HQ_HEADING);
  assert.ok(sub !== '', `docs/operations.md に「${HQ_HEADING}」の節がありません`);
  assert.ok(sub.includes('fleet 自身の Claude の端末は閉じない'), 'hq の節に「fleet 自身の Claude の端末は閉じない」がありません');
});

test('harness/CLAUDE.harness.md：Orca の項（起動と監視・orca-cli の行）に、split の向き（--direction）は vertical で左右とする扱いがある', () => {
  const line = readText('harness/CLAUDE.harness.md').split('\n').find((l) => l.includes('起動と監視') && l.includes('orca-cli'));
  assert.ok(line, 'harness/CLAUDE.harness.md に「起動と監視」と「orca-cli」を含む行がありません');
  assert.ok(line.includes('--direction'), 'Orca の項の行に「--direction」がありません');
  assert.ok(VERTICAL_IS_LEFT_RIGHT.test(line), 'Orca の項の行に「vertical で左右」がありません');
});

test('docs/operations.md：hq の節で、hq のペインが真ん中の列に上から Epic/Issue（hq board）→ 人待ち（hq todo）→ ログ（hq log）の順', () => {
  const sub = section(readText(OPERATIONS), HQ_HEADING);
  assert.ok(sub !== '', `docs/operations.md に「${HQ_HEADING}」の節がありません`);
  const line = sub.split('\n').find((l) => l.includes('hq のワークスペース') && l.includes('真ん中の列'));
  assert.ok(line, 'hq の節に「hq のワークスペース」と「真ん中の列」を含む行がありません');
  const words = ['Epic/Issue', 'panes.ts hq board', '人待ち', 'panes.ts hq todo', 'ログ', 'panes.ts hq log'];
  const rest = line.slice(line.indexOf('真ん中の列'));
  let at = 0;
  for (const w of words) {
    const i = rest.indexOf(w, at);
    assert.ok(i >= 0, `docs/operations.md の hq のペインの並び：「${w}」が前の語句の後ろにありません（順：${words.join(' → ')}）`);
    at = i + w.length;
  }
});
