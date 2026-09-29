// agent:delegate-merge（Merge の委任ラベル）を Agent が付け外しできないことと、ラベル定義・deny への登録を確かめる（Issue #210）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';
import { allLabelDefs, delegateMergeConfig, LABEL_DEFS, LABELS, loadConfig, type HarnessConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const DELEGATE = 'agent:delegate-merge';

/** guard.ts の main が設定から作るのと同じ形の ctx */
function ctxFromConfig(): GuardContext {
  const config = loadConfig();
  return {
    defaultBranch: config.defaultBranch,
    protectedLabels: [LABELS.planOk, LABELS.hold, config.autoMergeStopLabel, delegateMergeConfig(config).label],
    currentBranch: 'claude/issue-210-x',
  };
}

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

const delegateCmds = [
  `gh issue edit 1 --add-label ${DELEGATE}`,
  `gh issue edit 1 --add-label=${DELEGATE}`,
  `gh issue edit 1 --remove-label ${DELEGATE}`,
  `gh issue edit 1 --remove-label foo,${DELEGATE}`,
  `gh pr edit 1 --add-label ${DELEGATE}`,
  `gh pr edit 1 --remove-label ${DELEGATE}`,
  'gh issue edit 1 --add-label Agent:Delegate-Merge',
  `gh api repos/o/r/issues/1/labels -f 'labels[]=${DELEGATE}'`,
  `gh api -X POST repos/o/r/issues/1/labels -f 'labels[]=${DELEGATE}'`,
  `gh api -X DELETE repos/o/r/issues/1/labels/${DELEGATE}`,
  `gh api --method DELETE repos/o/r/issues/1/labels/${DELEGATE}`,
];

const unrelatedCmds = [
  'gh issue edit 1 --add-label priority:high',
  'gh issue edit 1 --remove-label priority:high',
  'gh pr edit 1 --add-label priority:high',
  "gh api repos/o/r/issues/1/labels -f 'labels[]=priority:high'",
];

test('設定から作る保護ラベルに agent:delegate-merge が入る（delegateMergeConfig の label）', () => {
  assert.equal(delegateMergeConfig(loadConfig()).label, DELEGATE);
  assert.ok(ctxFromConfig().protectedLabels.includes(DELEGATE));
});

test('delegateMerge が無い設定では既定（agent:delegate-merge・2時間・残り30分）を返す', () => {
  const config = loadConfig();
  const bare: HarnessConfig = { ...config };
  delete bare.delegateMerge;
  assert.deepEqual(delegateMergeConfig(bare),{ label: DELEGATE, hours: 2, minRemainingMinutes: 30 });
});

test('agent:delegate-merge を付け外しする gh の操作を止める（設定から作る保護ラベル）', () => {
  const ctx = ctxFromConfig();
  for (const cmd of delegateCmds) {
    const d = decide(bash(cmd), ctx);
    assert.equal(d.deny, true, `止めるべき: ${cmd}`);
    if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${cmd}`);
  }
});

test('agent:delegate-merge を付け外しする gh の操作を decideRaw でも止める（設定から作る保護ラベル）', () => {
  const ctx = ctxFromConfig();
  for (const cmd of delegateCmds) {
    assert.equal(decideRaw(JSON.stringify(bash(cmd)), ctx).deny, true, `止めるべき: ${cmd}`);
  }
});

test('設定が読めないとき（ctx が null）も agent:delegate-merge の付け外しを止める', () => {
  for (const cmd of delegateCmds) {
    const d = decideRaw(JSON.stringify(bash(cmd)), null);
    assert.equal(d.deny, true, `止めるべき（fallback）: ${cmd}`);
    if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${cmd}`);
  }
});

test('関係の無いラベル（priority:high）の付け外しは通す', () => {
  const ctx = ctxFromConfig();
  for (const cmd of unrelatedCmds) {
    assert.deepEqual(decide(bash(cmd), ctx), { deny: false }, `通すべき: ${cmd}`);
    assert.deepEqual(decideRaw(JSON.stringify(bash(cmd)), ctx), { deny: false }, `通すべき: ${cmd}`);
  }
});

test('関係の無いラベルの付け外しは設定が読めないとき（ctx が null）も止めない', () => {
  for (const cmd of unrelatedCmds) {
    const d = decideRaw(JSON.stringify(bash(cmd)), null);
    assert.equal(d.deny && d.reason.includes(DELEGATE), false, `delegate-merge を理由に止めるべきでない: ${cmd}`);
  }
});

test('.claude/settings.json と deny の雛形に Bash(*agent:delegate-merge*) がある', () => {
  for (const p of ['.claude/settings.json', 'harness/templates/claude-settings.deny.json']) {
    const json = JSON.parse(readFileSync(join(root, p), 'utf8')) as { permissions?: { deny?: string[] } };
    assert.ok(json.permissions?.deny?.includes(`Bash(*${DELEGATE}*)`), `${p} の permissions.deny に Bash(*${DELEGATE}*) が無い`);
  }
});

test('ラベル定義（LABEL_DEFS）と setup.ts が作るラベルの一覧（allLabelDefs）に agent:delegate-merge がある', () => {
  assert.ok(LABEL_DEFS.some((d) => d.name === DELEGATE), 'LABEL_DEFS に無い');
  const def = allLabelDefs(loadConfig()).find((d) => d.name === DELEGATE);
  assert.ok(def, 'allLabelDefs に無い');
  assert.match(def.color, /^[0-9a-f]{6}$/i);
  assert.ok(def.description.length > 0 && def.description.length <= 100, 'description は 1〜100 文字');
});

test('harness.config.json の delegateMergeExclude が harness.config.json と harness/gates/** を含む', () => {
  const exclude = loadConfig().delegateMergeExclude;
  assert.ok(Array.isArray(exclude), 'delegateMergeExclude が無い');
  assert.ok(exclude.includes('harness.config.json'));
  assert.ok(exclude.includes('harness/gates/**'));
});

test('規則：harness/CLAUDE.harness.md の「やってはいけないこと」と各 skill・routine.md が agent:delegate-merge の付け外しを禁じる', () => {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const rules = read('harness/CLAUDE.harness.md');
  const section = rules.slice(rules.indexOf('## やってはいけないこと'));
  assert.ok(section.split('\n').includes(`- \`${DELEGATE}\` の付け外し（委任 Merge は人だけが始める）`), 'CLAUDE.harness.md の「やってはいけないこと」に行が無い');
  for (const p of ['.claude/routine.md', ...['ship', 'fleet', 'plan', 'implement', 'judge', 'fix', 'sync'].map((s) => `.claude/skills/${s}/SKILL.md`)]) {
    const line = read(p).split('\n').find((l) => l.includes('やってはいけないこと'));
    assert.ok(line?.includes(`\`${DELEGATE}\``), `${p} の「やってはいけないこと」に ${DELEGATE} が無い`);
  }
});
