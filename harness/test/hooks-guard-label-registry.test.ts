// bypass・委任承認・auto mode のラベルの、設定の既定・保護ラベル（protectedLabelsOf）・ラベル定義・deny・gate.yml・子プロセスの hook への登録を表で確かめる（Issue #245・#210・#241・#344 を #1010 でまとめた。拒否そのものは hooks-guard-labels）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { decide, protectedLabelsOf, type GuardContext, type HookInput } from '../../.claude/hooks/guard.ts';
import * as lib from '../lib/config.ts';
import { allLabelDefs, AUTO_MODE_LABEL_DEFAULT, BYPASS_MERGE_DEFAULTS, bypassMergeConfig, delegateConfig, LABEL_DEFS, LABELS, loadConfig, type HarnessConfig } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');
const BYPASS = 'agent:bypass-merge';
const PLAN = 'agent:delegate-plan';
const MERGE = 'agent:delegate-merge';
const AUTO = 'agent:auto-mode';

const bash = (command: string): HookInput => ({ tool_name: 'Bash', tool_input: { command } });

test('設定のラベル名：bypassMergeConfig・delegateConfig が今の設定で既定の名前を返す', () => {
  const config = loadConfig();
  const cases: [string, string][] = [
    [bypassMergeConfig(config).label, BYPASS],
    [delegateConfig(config).planLabel, PLAN],
    [delegateConfig(config).mergeLabel, MERGE],
  ];
  for (const [actual, expected] of cases) assert.equal(actual, expected);
});

test('bypassMerge が無い設定では既定（agent:bypass-merge）を返す', () => {
  const bare: HarnessConfig = { ...loadConfig() };
  delete bare.bypassMerge;
  assert.deepEqual(bypassMergeConfig(bare), { label: BYPASS });
  assert.equal(BYPASS_MERGE_DEFAULTS.label, BYPASS);
});

test('delegate・delegateMerge が無い設定では既定（agent:delegate-plan・agent:delegate-merge）を返す', () => {
  const bare: HarnessConfig = { ...loadConfig() };
  delete bare.delegate;
  delete bare.delegateMerge;
  assert.deepEqual(delegateConfig(bare), { planLabel: PLAN, mergeLabel: MERGE });
});

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

test('.claude/settings.json と deny の雛形に、bypass・委任承認・auto mode のラベルの規則が agent:bypass-merge と同じ形で12個ずつあり、2つが食い違わない', () => {
  const denyOf = (p: string): string[] => (JSON.parse(readFileSync(join(root, p), 'utf8')) as { permissions?: { deny?: string[] } }).permissions?.deny ?? [];
  const settings = denyOf('.claude/settings.json');
  const template = denyOf('harness/templates/claude-settings.deny.json');
  for (const label of [BYPASS, PLAN, MERGE, AUTO]) {
    const rulesOf: string[][] = [];
    for (const [p, deny] of [['.claude/settings.json', settings], ['harness/templates/claude-settings.deny.json', template]] as const) {
      for (const c of ['gh issue edit', 'gh issue create', 'gh pr edit', 'gh pr create', 'gh label', 'gh api']) {
        for (const rule of [`Bash(${c} *${label}*)`, `Bash(* ${c} *${label}*)`]) {
          assert.ok(deny.includes(rule), `${p} の permissions.deny に ${rule} が無い`);
        }
      }
      const rules = deny.filter((r) => r.includes(label)).sort();
      const bypassShape = deny.filter((r) => r.includes(BYPASS)).map((r) => r.replace(BYPASS, label)).sort();
      assert.equal(rules.length, 12, `${p}：${label} の規則は12個`);
      assert.deepEqual(rules, bypassShape, `${p}：${label} を agent:bypass-merge と同じ形の規則にする`);
      rulesOf.push(rules);
    }
    assert.deepEqual(rulesOf[0], rulesOf[1], `.claude/settings.json と雛形の ${label} の規則が食い違う`);
  }
});

test('ラベル定義（LABEL_DEFS）と setup.ts が作るラベルの一覧（allLabelDefs）に bypass・委任承認のラベルがある', () => {
  for (const label of [BYPASS, PLAN, MERGE]) {
    assert.ok(LABEL_DEFS.some((d) => d.name === label), `LABEL_DEFS に ${label} が無い`);
    const def = allLabelDefs(loadConfig()).find((d) => d.name === label);
    assert.ok(def, `allLabelDefs に ${label} が無い`);
    assert.match(def.color, /^[0-9a-f]{6}$/i);
    assert.ok(def.description.length > 0 && def.description.length <= 100, `${label}：description は 1〜100 文字`);
  }
});

test('gate.yml：Issue の項に bypass のラベルがあり、設定のラベル名と同じ', () => {
  const yml = readFileSync(join(root, '.github', 'workflows', 'gate.yml'), 'utf8');
  const start = yml.indexOf("(github.event_name != 'issues' ||");
  const end = yml.indexOf("(github.event_name != 'pull_request_target' ||");
  assert.ok(start >= 0 && end > start, 'gate.yml の Issue の項が読めません');
  assert.ok(yml.slice(start, end).includes(`github.event.label.name == '${bypassMergeConfig(loadConfig()).label}'`), 'gate.yml の Issue の項に無い');
});

test('harness.config.json の delegateMergeExclude が harness.config.json と harness/gates/** を含む', () => {
  const exclude = loadConfig().delegateMergeExclude;
  assert.ok(Array.isArray(exclude), 'delegateMergeExclude が無い');
  assert.ok(exclude.includes('harness.config.json'));
  assert.ok(exclude.includes('harness/gates/**'));
});
