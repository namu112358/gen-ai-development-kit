// agent:auto-mode（auto mode のラベル）をセッションが付け外しできないことと、保護ラベル・deny・規則への登録を確かめる（Issue #344）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, decideRaw, protectedLabelsOf, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';
import * as lib from '../lib/config.ts';
import { AUTO_MODE_LABEL_DEFAULT, bypassMergeConfig, delegateConfig, LABELS, loadConfig, type HarnessConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const AUTO = 'agent:auto-mode';

/** guard.ts の main と同じく protectedLabelsOf で作る ctx */
function ctxFromConfig(): GuardContext {
  const config = loadConfig();
  return { defaultBranch: config.defaultBranch, protectedLabels: protectedLabelsOf(config, lib), currentBranch: 'claude/issue-344-x' };
}

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

const autoCmds = [
  `gh issue edit 1 --add-label ${AUTO}`,
  `gh issue edit 1 --add-label=${AUTO}`,
  `gh issue edit 1 --remove-label ${AUTO}`,
  `gh issue edit 1 --remove-label foo,${AUTO}`,
  `gh issue edit 1 --add-label ${AUTO},bar`,
  `gh pr edit 1 --add-label ${AUTO}`,
  `gh pr edit 1 --remove-label ${AUTO}`,
  'gh issue edit 1 --add-label Agent:Auto-Mode',
  `gh api repos/o/r/issues/1/labels -f 'labels[]=${AUTO}'`,
  `gh api -X POST repos/o/r/issues/1/labels -f 'labels[]=${AUTO}'`,
  `gh api -X DELETE repos/o/r/issues/1/labels/${AUTO}`,
  `gh api --method DELETE repos/o/r/issues/1/labels/${AUTO}`,
];

const unrelatedCmds = [
  'gh issue edit 1 --add-label priority:high',
  'gh issue edit 1 --remove-label priority:high',
  'gh pr edit 1 --add-label priority:high',
  "gh api repos/o/r/issues/1/labels -f 'labels[]=priority:high'",
];

test('既定の名前（AUTO_MODE_LABEL_DEFAULT）は agent:auto-mode', () => {
  assert.equal(AUTO_MODE_LABEL_DEFAULT, AUTO);
});

test('protectedLabelsOf：設定から作る保護ラベルに agent:auto-mode と今までの6つが入る', () => {
  const config = loadConfig();
  const labels = protectedLabelsOf(config, lib);
  assert.ok(labels.includes(AUTO), 'agent:auto-mode が無い');
  for (const l of [LABELS.planOk, LABELS.hold, config.autoMergeStopLabel, delegateConfig(config).planLabel, delegateConfig(config).mergeLabel, bypassMergeConfig(config).label]) {
    assert.ok(labels.includes(l), `${l} が無い`);
  }
  assert.equal(labels.filter((l) => l === AUTO).length, 1, '設定の名前と既定の名前が同じなら1つ');
});

test('protectedLabelsOf：autoMode.label を別の名前にしても、その名前と既定の名前の両方が入る', () => {
  const base = loadConfig();
  const config: HarnessConfig = { ...base, autoMode: { ...base.autoMode, label: 'custom:auto' } };
  const labels = protectedLabelsOf(config, lib);
  assert.ok(labels.includes('custom:auto'), '設定の名前が無い');
  assert.ok(labels.includes(AUTO), '既定の名前が無い');
  const ctx: GuardContext = { defaultBranch: base.defaultBranch, protectedLabels: labels, currentBranch: 'claude/issue-344-x' };
  for (const cmd of ['gh issue edit 1 --add-label custom:auto', `gh issue edit 1 --add-label ${AUTO}`]) {
    assert.equal(decide(bash(cmd), ctx).deny, true, `止めるべき: ${cmd}`);
  }
});

test('protectedLabelsOf：autoMode が無い設定では既定の名前が入る', () => {
  const bare: HarnessConfig = { ...loadConfig() };
  delete bare.autoMode;
  assert.ok(protectedLabelsOf(bare, lib).includes(AUTO));
});

test('protectedLabelsOf：autoMode.label が空・文字列でない設定では throw する', () => {
  const base = loadConfig();
  assert.throws(() => protectedLabelsOf({ ...base, autoMode: { ...base.autoMode, label: '' } }, lib));
  assert.throws(() => protectedLabelsOf({ ...base, autoMode: { ...base.autoMode, label: 1 as unknown as string } } as HarnessConfig, lib));
});

test('protectedLabelsOf：autoMode.jev の書式が誤っていても throw しない', () => {
  const base = loadConfig();
  const config = { ...base, autoMode: { label: AUTO, jev: { dangerSafe: 'x', plan: 1, pr: null } } } as unknown as HarnessConfig;
  let labels: string[] = [];
  assert.doesNotThrow(() => {
    labels = protectedLabelsOf(config, lib);
  });
  assert.ok(labels.includes(AUTO));
});

test('agent:auto-mode を付け外しする gh の操作を decide で止める（protectedLabelsOf で作る ctx）', () => {
  const ctx = ctxFromConfig();
  for (const cmd of autoCmds) {
    const d = decide(bash(cmd), ctx);
    assert.equal(d.deny, true, `止めるべき: ${cmd}`);
    if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${cmd}`);
  }
});

test('agent:auto-mode を付け外しする gh の操作を decideRaw でも止める（protectedLabelsOf で作る ctx）', () => {
  const ctx = ctxFromConfig();
  for (const cmd of autoCmds) {
    assert.equal(decideRaw(JSON.stringify(bash(cmd)), ctx).deny, true, `止めるべき: ${cmd}`);
  }
});

test('設定が読めないとき（ctx が null）も agent:auto-mode の付け外しを止める（FALLBACK_LABELS）', () => {
  for (const cmd of autoCmds) {
    const d = decideRaw(JSON.stringify(bash(cmd)), null);
    assert.equal(d.deny, true, `止めるべき（fallback）: ${cmd}`);
    if (d.deny) assert.ok(d.reason.length > 0, `理由が空: ${cmd}`);
  }
});

test('子プロセス：guard.ts の main が agent:auto-mode の付け外しに deny を出す', () => {
  const input = { ...bash(`gh issue edit 1 --add-label ${AUTO}`), hook_event_name: 'PreToolUse', cwd: root };
  const r = spawnSync(process.execPath, ['.claude/hooks/guard.ts'], { cwd: root, input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(r.status, 0, `exit code（stderr: ${r.stderr}）`);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput?: { hookEventName?: unknown; permissionDecision?: unknown; permissionDecisionReason?: unknown } };
  assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput?.permissionDecisionReason;
  assert.ok(typeof reason === 'string' && reason.length > 0, '理由が空');
});

test('関係の無いラベル（priority:high）の付け外しは通す', () => {
  const ctx = ctxFromConfig();
  for (const cmd of unrelatedCmds) {
    assert.deepEqual(decide(bash(cmd), ctx), { deny: false }, `通すべき: ${cmd}`);
    assert.deepEqual(decideRaw(JSON.stringify(bash(cmd)), ctx), { deny: false }, `通すべき: ${cmd}`);
  }
});

test('関係の無いラベルの付け外しは設定が読めないとき（ctx が null）も auto-mode を理由に止めない', () => {
  for (const cmd of unrelatedCmds) {
    const d = decideRaw(JSON.stringify(bash(cmd)), null);
    assert.equal(d.deny && d.reason.includes(AUTO), false, `auto-mode を理由に止めるべきでない: ${cmd}`);
  }
});

test('.claude/settings.json と deny の雛形に、agent:auto-mode の規則が agent:bypass-merge と同じ12個あり、2つが食い違わない', () => {
  const autoRulesOf: string[][] = [];
  for (const p of ['.claude/settings.json', 'harness/templates/claude-settings.deny.json']) {
    const json = JSON.parse(readFileSync(join(root, p), 'utf8')) as { permissions?: { deny?: string[] } };
    const deny = json.permissions?.deny ?? [];
    for (const c of ['gh issue edit', 'gh issue create', 'gh pr edit', 'gh pr create', 'gh label', 'gh api']) {
      for (const rule of [`Bash(${c} *${AUTO}*)`, `Bash(* ${c} *${AUTO}*)`]) {
        assert.ok(deny.includes(rule), `${p} の permissions.deny に ${rule} が無い`);
      }
    }
    const bypassRules = deny.filter((r) => r.includes('agent:bypass-merge')).map((r) => r.replace('agent:bypass-merge', AUTO)).sort();
    const autoRules = deny.filter((r) => r.includes(AUTO)).sort();
    assert.equal(autoRules.length, 12, `${p}：agent:auto-mode の規則は12個`);
    assert.deepEqual(autoRules, bypassRules, `${p}：agent:bypass-merge と同じ形の規則にする`);
    autoRulesOf.push(autoRules);
  }
  assert.deepEqual(autoRulesOf[0], autoRulesOf[1], '.claude/settings.json と雛形の agent:auto-mode の規則が食い違う');
});

test('規則：harness/CLAUDE.harness.md の「やってはいけないこと」と各 skill・routine.md が agent:auto-mode の付け外しを禁じる', () => {
  const read = (p: string) => readFileSync(join(root, p), 'utf8');
  const rules = read('harness/CLAUDE.harness.md');
  const section = rules.slice(rules.indexOf('## やってはいけないこと'));
  assert.ok(section.split('\n').some((l) => l.startsWith('- ') && l.includes(`\`${AUTO}\``)), 'CLAUDE.harness.md の「やってはいけないこと」に行が無い');
  for (const p of ['.claude/routine.md', ...['ship', 'fleet', 'plan', 'implement', 'judge', 'fix', 'sync'].map((s) => `.claude/skills/${s}/SKILL.md`)]) {
    const line = read(p).split('\n').find((l) => l.includes('やってはいけないこと'));
    assert.ok(line?.includes(`\`${AUTO}\``), `${p} の「やってはいけないこと」に ${AUTO} が無い`);
  }
});
