// agent:bypass-merge（bypass モードのラベル）をセッションが付け外しできないことと、ラベル定義・deny・規則への登録を確かめる（Issue #245）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, decideRaw, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';
import { allLabelDefs, bypassMergeConfig, BYPASS_MERGE_DEFAULTS, delegateMergeConfig, LABEL_DEFS, LABELS, loadConfig, type HarnessConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const BYPASS = 'agent:bypass-merge';

/** guard.ts の main が設定から作るのと同じ形の ctx */
function ctxFromConfig(): GuardContext {
  const config = loadConfig();
  return {
    defaultBranch: config.defaultBranch,
    protectedLabels: [LABELS.planOk, LABELS.hold, config.autoMergeStopLabel, delegateMergeConfig(config).label, bypassMergeConfig(config).label],
    currentBranch: 'claude/issue-245-x',
  };
}

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

const bypassCmds = [
  `gh issue edit 1 --add-label ${BYPASS}`,
  `gh issue edit 1 --add-label=${BYPASS}`,
  `gh issue edit 1 --remove-label ${BYPASS}`,
  `gh issue edit 1 --remove-label foo,${BYPASS}`,
  `gh pr edit 1 --add-label ${BYPASS}`,
  `gh pr edit 1 --remove-label ${BYPASS}`,
  'gh issue edit 1 --add-label Agent:Bypass-Merge',
  `gh api repos/o/r/issues/1/labels -f 'labels[]=${BYPASS}'`,
  `gh api -X POST repos/o/r/issues/1/labels -f 'labels[]=${BYPASS}'`,
  `gh api -X DELETE repos/o/r/issues/1/labels/${BYPASS}`,
  `gh api --method DELETE repos/o/r/issues/1/labels/${BYPASS}`,
];

const unrelatedCmds = [
  'gh issue edit 1 --add-label priority:high',
  'gh issue edit 1 --remove-label priority:high',
  'gh pr edit 1 --add-label priority:high',
  "gh api repos/o/r/issues/1/labels -f 'labels[]=priority:high'",
];

test('設定から作る保護ラベルに agent:bypass-merge が入る（bypassMergeConfig の label）', () => {
  assert.equal(bypassMergeConfig(loadConfig()).label, BYPASS);
  assert.ok(ctxFromConfig().protectedLabels.includes(BYPASS));
});

test('bypassMerge が無い設定では既定（agent:bypass-merge）を返す', () => {
  const bare: HarnessConfig = { ...loadConfig() };
  delete bare.bypassMerge;
  assert.deepEqual(bypassMergeConfig(bare), { label: BYPASS });
  assert.equal(BYPASS_MERGE_DEFAULTS.label, BYPASS);
});

test('agent:bypass-merge を付け外しする gh の操作を止める（設定から作る保護ラベル）', () => {
  const ctx = ctxFromConfig();
  for (const cmd of bypassCmds) {
    const d = decide(bash(cmd), ctx);
    assert.equal(d.deny, true, `止めるべき: ${cmd}`);
    if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${cmd}`);
  }
});

test('agent:bypass-merge を付け外しする gh の操作を decideRaw でも止める（設定から作る保護ラベル）', () => {
  const ctx = ctxFromConfig();
  for (const cmd of bypassCmds) {
    assert.equal(decideRaw(JSON.stringify(bash(cmd)), ctx).deny, true, `止めるべき: ${cmd}`);
  }
});

test('設定が読めないとき（ctx が null）も agent:bypass-merge の付け外しを止める（FALLBACK_LABELS）', () => {
  for (const cmd of bypassCmds) {
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

test('関係の無いラベルの付け外しは設定が読めないとき（ctx が null）も bypass-merge を理由に止めない', () => {
  for (const cmd of unrelatedCmds) {
    const d = decideRaw(JSON.stringify(bash(cmd)), null);
    assert.equal(d.deny && d.reason.includes(BYPASS), false, `bypass-merge を理由に止めるべきでない: ${cmd}`);
  }
});

test('.claude/settings.json と deny の雛形に、agent:bypass-merge の規則が agent:delegate-merge と同じ12個ある', () => {
  for (const p of ['.claude/settings.json', 'harness/templates/claude-settings.deny.json']) {
    const json = JSON.parse(readFileSync(join(root, p), 'utf8')) as { permissions?: { deny?: string[] } };
    const deny = json.permissions?.deny ?? [];
    for (const c of ['gh issue edit', 'gh issue create', 'gh pr edit', 'gh pr create', 'gh label', 'gh api']) {
      for (const rule of [`Bash(${c} *${BYPASS}*)`, `Bash(* ${c} *${BYPASS}*)`]) {
        assert.ok(deny.includes(rule), `${p} の permissions.deny に ${rule} が無い`);
      }
    }
    const delegateRules = deny.filter((r) => r.includes('agent:delegate-merge')).map((r) => r.replace('agent:delegate-merge', BYPASS)).sort();
    const bypassRules = deny.filter((r) => r.includes(BYPASS)).sort();
    assert.deepEqual(bypassRules, delegateRules, `${p}：agent:delegate-merge と同じ形の規則にする`);
  }
});

test('ラベル定義（LABEL_DEFS）と setup.ts が作るラベルの一覧（allLabelDefs）に agent:bypass-merge がある', () => {
  assert.ok(LABEL_DEFS.some((d) => d.name === BYPASS), 'LABEL_DEFS に無い');
  const def = allLabelDefs(loadConfig()).find((d) => d.name === BYPASS);
  assert.ok(def, 'allLabelDefs に無い');
  assert.match(def.color, /^[0-9a-f]{6}$/i);
  assert.ok(def.description.length > 0 && def.description.length <= 100, 'description は 1〜100 文字');
});

test('規則：harness/CLAUDE.harness.md の「やってはいけないこと」と各 skill・routine.md が agent:bypass-merge の付け外しを禁じる', () => {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const rules = read('harness/CLAUDE.harness.md');
  const section = rules.slice(rules.indexOf('## やってはいけないこと'));
  assert.ok(section.split('\n').some((l) => l.startsWith('- ') && l.includes(`\`${BYPASS}\``)), 'CLAUDE.harness.md の「やってはいけないこと」に行が無い');
  for (const p of ['.claude/routine.md', ...['ship', 'fleet', 'plan', 'implement', 'judge', 'fix', 'sync'].map((s) => `.claude/skills/${s}/SKILL.md`)]) {
    const line = read(p).split('\n').find((l) => l.includes('やってはいけないこと'));
    assert.ok(line?.includes(`\`${BYPASS}\``), `${p} の「やってはいけないこと」に ${BYPASS} が無い`);
  }
});

test('gate.yml：Issue の項に bypass のラベルがあり、設定のラベル名と同じ', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8');
  const start = yml.indexOf("(github.event_name != 'issues' ||");
  const end = yml.indexOf("(github.event_name != 'pull_request_target' ||");
  assert.ok(start >= 0 && end > start, 'gate.yml の Issue の項が読めません');
  assert.ok(yml.slice(start, end).includes(`github.event.label.name == '${BYPASS}'`), 'gate.yml の Issue の項に無い');
  assert.equal(bypassMergeConfig(loadConfig()).label, BYPASS);
});
