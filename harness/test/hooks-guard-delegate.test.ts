// 委任承認のラベル（agent:delegate-plan・agent:delegate-merge）を Agent が付け外しできないことと、ラベル定義・deny への登録を確かめる（Issue #210・#241）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';
import { allLabelDefs, delegateConfig, LABEL_DEFS, LABELS, loadConfig, type HarnessConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const PLAN = 'agent:delegate-plan';
const MERGE = 'agent:delegate-merge';
const DELEGATES = [PLAN, MERGE];

/** guard.ts の main が設定から作るのと同じ形の ctx */
function ctxFromConfig(): GuardContext {
  const config = loadConfig();
  const d = delegateConfig(config);
  return {
    defaultBranch: config.defaultBranch,
    protectedLabels: [LABELS.planOk, LABELS.hold, config.autoMergeStopLabel, d.planLabel, d.mergeLabel],
    currentBranch: 'claude/issue-241-x',
  };
}

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

/** 'agent:delegate-plan' → 'Agent:Delegate-Plan'（大文字小文字を変えても止める） */
const titleCase = (label: string): string => label.split(/([:-])/).map((s) => (s.length > 1 ? s[0]!.toUpperCase() + s.slice(1) : s)).join('');

function delegateCmds(label: string): string[] {
  return [
    `gh issue edit 1 --add-label ${label}`,
    `gh issue edit 1 --add-label=${label}`,
    `gh issue edit 1 --remove-label ${label}`,
    `gh issue edit 1 --remove-label foo,${label}`,
    `gh pr edit 1 --add-label ${label}`,
    `gh pr edit 1 --remove-label ${label}`,
    `gh issue edit 1 --add-label ${titleCase(label)}`,
    `gh api repos/o/r/issues/1/labels -f 'labels[]=${label}'`,
    `gh api -X POST repos/o/r/issues/1/labels -f 'labels[]=${label}'`,
    `gh api -X DELETE repos/o/r/issues/1/labels/${label}`,
    `gh api --method DELETE repos/o/r/issues/1/labels/${label}`,
  ];
}

const unrelatedCmds = [
  'gh issue edit 1 --add-label priority:high',
  'gh issue edit 1 --remove-label priority:high',
  'gh pr edit 1 --add-label priority:high',
  "gh api repos/o/r/issues/1/labels -f 'labels[]=priority:high'",
];

test('設定から作る保護ラベルに agent:delegate-plan と agent:delegate-merge が入る（delegateConfig の planLabel・mergeLabel）', () => {
  const d = delegateConfig(loadConfig());
  assert.equal(d.planLabel, PLAN);
  assert.equal(d.mergeLabel, MERGE);
  for (const label of DELEGATES) assert.ok(ctxFromConfig().protectedLabels.includes(label), label);
});

test('delegate・delegateMerge が無い設定では既定（agent:delegate-plan・agent:delegate-merge）を返す', () => {
  const bare: HarnessConfig = { ...loadConfig() };
  delete bare.delegate;
  delete bare.delegateMerge;
  assert.deepEqual(delegateConfig(bare), { planLabel: PLAN, mergeLabel: MERGE });
});

test('委任承認のラベルを付け外しする gh の操作を止める（設定から作る保護ラベル）', () => {
  const ctx = ctxFromConfig();
  for (const label of DELEGATES) {
    for (const cmd of delegateCmds(label)) {
      const d = decide(bash(cmd), ctx);
      assert.equal(d.deny, true, `止めるべき: ${cmd}`);
      if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${cmd}`);
    }
  }
});

test('委任承認のラベルを付け外しする gh の操作を decideRaw でも止める（設定から作る保護ラベル）', () => {
  const ctx = ctxFromConfig();
  for (const label of DELEGATES) {
    for (const cmd of delegateCmds(label)) assert.equal(decideRaw(JSON.stringify(bash(cmd)), ctx).deny, true, `止めるべき: ${cmd}`);
  }
});

test('設定が読めないとき（ctx が null）も委任承認のラベルの付け外しを止める（FALLBACK_LABELS）', () => {
  for (const label of DELEGATES) {
    for (const cmd of delegateCmds(label)) {
      const d = decideRaw(JSON.stringify(bash(cmd)), null);
      assert.equal(d.deny, true, `止めるべき（fallback）: ${cmd}`);
      if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${cmd}`);
    }
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
    assert.equal(d.deny && DELEGATES.some((l) => d.reason.includes(l)), false, `委任承認のラベルを理由に止めるべきでない: ${cmd}`);
  }
});

test('.claude/settings.json と deny の雛形に、委任承認のラベルを付け外しする gh の規則が agent:delegate-merge と同じ形である', () => {
  for (const p of ['.claude/settings.json', 'harness/templates/claude-settings.deny.json']) {
    const json = JSON.parse(readFileSync(join(root, p), 'utf8')) as { permissions?: { deny?: string[] } };
    for (const label of DELEGATES) {
      for (const c of ['gh issue edit', 'gh issue create', 'gh pr edit', 'gh pr create', 'gh label', 'gh api']) {
        for (const rule of [`Bash(${c} *${label}*)`, `Bash(* ${c} *${label}*)`]) {
          assert.ok(json.permissions?.deny?.includes(rule), `${p} の permissions.deny に ${rule} が無い`);
        }
      }
    }
  }
});

test('ラベル定義（LABEL_DEFS）と setup.ts が作るラベルの一覧（allLabelDefs）に agent:delegate-plan と agent:delegate-merge がある', () => {
  for (const label of DELEGATES) {
    assert.ok(LABEL_DEFS.some((d) => d.name === label), `LABEL_DEFS に ${label} が無い`);
    const def = allLabelDefs(loadConfig()).find((d) => d.name === label);
    assert.ok(def, `allLabelDefs に ${label} が無い`);
    assert.match(def.color, /^[0-9a-f]{6}$/i);
    assert.ok(def.description.length > 0 && def.description.length <= 100, 'description は 1〜100 文字');
  }
});

test('harness.config.json の delegateMergeExclude が harness.config.json と harness/gates/** を含む', () => {
  const exclude = loadConfig().delegateMergeExclude;
  assert.ok(Array.isArray(exclude), 'delegateMergeExclude が無い');
  assert.ok(exclude.includes('harness.config.json'));
  assert.ok(exclude.includes('harness/gates/**'));
});

test('規則：harness/CLAUDE.harness.md の「やってはいけないこと」と各 skill・routine.md が委任承認のラベルの付け外しを禁じる', () => {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const rules = read('harness/CLAUDE.harness.md');
  const section = rules.slice(rules.indexOf('## やってはいけないこと'));
  const line = section.split('\n').find((l) => l.startsWith('- ') && l.includes(`\`${MERGE}\``));
  assert.ok(line, `CLAUDE.harness.md の「やってはいけないこと」に ${MERGE} の行が無い`);
  assert.ok(line.includes(`\`${PLAN}\``), `「やってはいけないこと」の行に ${PLAN} が無い: ${line}`);
  assert.match(line, /付け外し/);
  for (const p of ['.claude/routine.md', ...['ship', 'fleet', 'plan', 'implement', 'judge', 'fix', 'sync'].map((s) => `.claude/skills/${s}/SKILL.md`)]) {
    const l = read(p).split('\n').find((x) => x.includes('やってはいけないこと'));
    for (const label of DELEGATES) assert.ok(l?.includes(`\`${label}\``), `${p} の「やってはいけないこと」に ${label} が無い`);
  }
});
