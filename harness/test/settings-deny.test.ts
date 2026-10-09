// permissions.deny の保護ラベル・例外ラベルの規則が、ラベルを付け外しする gh のコマンドだけに当たり、読むだけのコマンドには当たらないことを確かめる（Issue #218・#241）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { denyOf, hits, matchesRule, SETTINGS, TEMPLATE } from './support/settings-deny.ts';

/** 規則に書く印（保護ラベルと、例外ラベルをまとめる :exempt） */
const MARKS = ['agent:plan-ok', 'agent:hold', 'agent:auto-merge-stopped', 'agent:delegate-plan', 'agent:delegate-merge', ':exempt'];
/** ラベルを付け外しできる gh のコマンド */
const COMMANDS = ['gh issue edit', 'gh issue create', 'gh pr edit', 'gh pr create', 'gh label', 'gh api'];
/** 保護ラベル・例外ラベルの具体的な名前（今ある8つと、今後増える例外ラベルの例） */
const LABEL_NAMES = [
  'agent:plan-ok',
  'agent:hold',
  'agent:auto-merge-stopped',
  'agent:delegate-plan',
  'agent:delegate-merge',
  'plan:exempt',
  'review:exempt',
  'test:exempt',
  'security:exempt',
];

/** ラベルに関わらない deny（Merge・push・Secret・資格情報など）。#218 の前の main にあったもの */
const OTHER_RULES = [
  'Bash(gh pr merge)',
  'Bash(gh pr merge *)',
  'Bash(* gh pr merge *)',
  'Bash(gh api *pulls/*/merge*)',
  'Bash(* gh api *pulls/*/merge*)',
  'Bash(gh api --method PUT *pulls/*/merge*)',
  'Bash(gh api -X PUT *pulls/*/merge*)',
  'Bash(gh api graphql *mergePullRequest*)',
  'Bash(*enablePullRequestAutoMerge*)',
  'Bash(*mergePullRequest*)',
  'Bash(gh pr ready *)',
  'Bash(gh variable *)',
  'Bash(gh api *actions/variables*)',
  'Bash(gh api *rulesets*)',
  'Bash(gh api *branches/*/protection*)',
  'Bash(gh secret *)',
  'Bash(git push * main)',
  'Bash(git push * *:main)',
  'Bash(git push * HEAD:main)',
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'mcp__github__merge_pull_request',
  'mcp__github__update_pull_request',
  'mcp__github__enable_pull_request_auto_merge',
  'Bash(env)',
  'Bash(env *)',
  'Bash(printenv*)',
  'Bash(set)',
  'Bash(*GITHUB_TOKEN*)',
  'Bash(*GH_TOKEN*)',
  'Bash(*ANTHROPIC_API_KEY*)',
  'Bash(gh auth*)',
  'Bash(*api.github.com*)',
  'Bash(*.config/gh*)',
  'Bash(*.git-credentials*)',
  'Bash(git config --get-regexp*)',
  'Bash(git credential*)',
];

/** ラベルの名前を含むが、ラベルを変えないコマンド */
const READ_ONLY = [
  'grep -n "agent:hold" .claude/hooks/guard.ts',
  "grep -rn 'agent:plan-ok' harness",
  "rg ':exempt' docs",
  'rg -n review:exempt harness/lib',
  'git log --grep agent:plan-ok',
  'git log --oneline -S agent:delegate-merge',
  'git log --oneline -S agent:delegate-plan',
  'gh issue view 218 --comments',
  'gh issue list --label agent:hold',
  'gh pr list --label test:exempt --state open',
  'cat harness.config.json | grep agent:auto-merge-stopped',
  'grep -c plan:exempt .claude/settings.json',
  'node --test harness/test/hooks-guard-labels.test.ts --test-name-pattern agent:hold',
];

/** ラベルを付け外しするコマンド（ラベルごとに作る） */
function mutating(label: string): string[] {
  return [
    `gh issue edit 1 --add-label ${label}`,
    `gh issue edit 1 --remove-label foo,${label}`,
    `gh issue edit 1 --add-label=${label}`,
    `gh issue create --title t -l ${label}`,
    `gh pr edit 1 --add-label ${label}`,
    `gh pr edit 1 --remove-label ${label}`,
    `gh pr create --title t --label ${label}`,
    `gh label create ${label}`,
    `gh label edit ${label} --name x`,
    `gh label delete ${label}`,
    `gh api repos/o/r/issues/1/labels -f 'labels[]=${label}'`,
    `gh api -X DELETE repos/o/r/issues/1/labels/${label}`,
    `cd x && gh pr edit 1 --add-label ${label}`,
    `GH_REPO=o/r gh issue edit 1 --add-label ${label}`,
    `true; gh api repos/o/r/issues/1/labels -f 'labels[]=${label}'`,
  ];
}

test('.claude/settings.json と deny の雛形の permissions.deny が同じ', () => {
  assert.deepEqual(denyOf(TEMPLATE), denyOf(SETTINGS));
});

for (const p of [SETTINGS, TEMPLATE]) {
  test(`${p}: ラベルの名前だけで当たる規則（Bash(*<ラベル>*)）が残っていない`, () => {
    const loose = denyOf(p).filter((r) => {
      const m = /^Bash\(\*([^*]*)\*\)$/.exec(r);
      return m !== null && MARKS.some((t) => m[1]!.toLowerCase().includes(t));
    });
    assert.deepEqual(loose, [], `${p} にラベルの名前だけで当たる規則が残っている`);
  });

  test(`${p}: 印 × gh のコマンドごとに Bash(C *T*) と Bash(* C *T*) がある`, () => {
    const deny = denyOf(p);
    const missing: string[] = [];
    for (const t of MARKS) {
      for (const c of COMMANDS) {
        for (const r of [`Bash(${c} *${t}*)`, `Bash(* ${c} *${t}*)`]) if (!deny.includes(r)) missing.push(r);
      }
    }
    assert.deepEqual(missing, [], `${p} の permissions.deny に足りない規則がある`);
  });

  test(`${p}: ラベルの名前を含む読むだけのコマンドはどの規則にも当たらない`, () => {
    const deny = denyOf(p);
    for (const cmd of READ_ONLY) assert.deepEqual(hits(deny, cmd), [], `当たるべきでない: ${cmd}`);
  });

  test(`${p}: 保護ラベル・例外ラベルを付け外しする gh のコマンドはどれかの規則に当たる`, () => {
    const deny = denyOf(p);
    for (const label of LABEL_NAMES) {
      for (const cmd of mutating(label)) assert.ok(hits(deny, cmd).length > 0, `当たるべき: ${cmd}`);
    }
  });

  test(`${p}: 関係の無いラベルの付け外しはラベルの規則に当たらない`, () => {
    const deny = denyOf(p);
    for (const cmd of ['gh issue edit 1 --add-label priority:high', 'gh pr edit 1 --remove-label area:harness', "gh api repos/o/r/issues/1/labels -f 'labels[]=bug'"]) {
      assert.deepEqual(hits(deny, cmd), [], `当たるべきでない: ${cmd}`);
    }
  });

  test(`${p}: Merge・push・Secret・資格情報の規則が残っている`, () => {
    const deny = denyOf(p);
    const missing = OTHER_RULES.filter((r) => !deny.includes(r));
    assert.deepEqual(missing, [], `${p} の permissions.deny から消えた規則がある`);
  });
}

test('照合の近似そのもの：* は任意の文字の並びで、型の全体に当てる', () => {
  assert.equal(matchesRule('Bash(gh issue edit *agent:hold*)', 'gh issue edit 1 --add-label agent:hold'), true);
  assert.equal(matchesRule('Bash(* gh pr merge *)', 'cd x && gh pr merge 1'), true);
  assert.equal(matchesRule('Bash(gh issue edit *agent:hold*)', 'echo gh issue edit 1 --add-label agent:hold'), false);
  assert.equal(matchesRule('Bash(gh pr merge)', 'gh pr merge 1'), false);
  assert.equal(matchesRule('mcp__github__merge_pull_request', 'mcp__github__merge_pull_request'), false);
});
