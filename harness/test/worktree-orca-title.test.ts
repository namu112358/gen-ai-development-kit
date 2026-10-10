// Issue #592（人の決定）：Orca の表示名を Issue のタイトルを短くしたもの（`#番号 <説明>`）にし、
// タイトルが取れなければ今までどおりブランチの後ろにすることを確かめる。Orca は本物を呼ばない（run を差し替える）。
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { labelOrcaWorktree, orcaShortTitle, orcaWorktreeLabel, orcaWorktreeSetArgs } from '../lib/worktree.ts';

const KIT = realpathSync(join(import.meta.dirname, '..', '..'));
const PATH = join(KIT, '..', 'repo.worktrees', 'claude-issue-592-orca-title');
const REF = 'claude/issue-592-orca-title';

test('orcaShortTitle：type(scope)!: を除いた説明を、空白を詰めて返す。形式に合わなければタイトルそのまま', () => {
  const cases: [string, string][] = [
    ['feat(harness): Orca の表示名を日本語にする', 'Orca の表示名を日本語にする'],
    ['fix!: 壊れた', '壊れた'],
    ['docs(a/b)!: 説明を直す', '説明を直す'],
    ['Orca の表示名を  日本語に', 'Orca の表示名を 日本語に'],
    ['unknown(x): 使えない type', 'unknown(x): 使えない type'],
    ['feat(harness): 連続の   空白\tを詰める  ', '連続の 空白 を詰める'],
    ['改行\nと\t連続の   空白', '改行 と 連続の 空白'],
    ['  前後の空白  ', '前後の空白'],
  ];
  for (const [title, want] of cases) assert.equal(orcaShortTitle(title), want, title);
});

test('orcaShortTitle：空・空白だけ・null・undefined は null', () => {
  for (const title of ['', '   ', '\n\t ', null, undefined]) assert.equal(orcaShortTitle(title), null, JSON.stringify(title));
});

test('orcaShortTitle：24 字ちょうどは切らず、25 字は先頭 24 字＋…（サロゲートペアは1字）', () => {
  const just = 'あ'.repeat(24);
  assert.equal(orcaShortTitle(`feat: ${just}`), just);
  assert.equal(orcaShortTitle(`feat: ${just}い`), `${just}…`);
  const kichi = '𠮷'.repeat(24);
  assert.equal(orcaShortTitle(kichi), kichi, 'サロゲートペア 24 字は切らない');
  assert.equal(orcaShortTitle(`${kichi}𠮷`), `${kichi}…`, 'サロゲートペア 25 字は 24 字＋…');
  assert.equal(orcaShortTitle(`${'a'.repeat(23)}𠮷𠮷`), `${'a'.repeat(23)}𠮷…`, 'サロゲートペアを途中で割らない');
});

test('orcaWorktreeLabel：タイトルがあれば #番号 <短いタイトル>、無ければブランチの後ろ', () => {
  assert.deepEqual(orcaWorktreeLabel(REF, 'feat(harness): Orca の表示名を日本語にする'), { issue: 592, displayName: '#592 Orca の表示名を日本語にする' });
  assert.deepEqual(orcaWorktreeLabel(REF, `feat: ${'あ'.repeat(30)}`), { issue: 592, displayName: `#592 ${'あ'.repeat(24)}…` });
  for (const title of [null, undefined, '', '  \n ']) {
    assert.deepEqual(orcaWorktreeLabel(REF, title), { issue: 592, displayName: '#592 orca-title' }, JSON.stringify(title));
  }
  assert.deepEqual(orcaWorktreeLabel(REF), { issue: 592, displayName: '#592 orca-title' }, '引数を渡さなければ今のまま');
});

test('orcaWorktreeLabel：形に合わないブランチはタイトルがあっても null', () => {
  for (const ref of ['main', 'claude/x', 'claude/issue-5', 'a'.repeat(40)]) {
    assert.equal(orcaWorktreeLabel(ref, 'feat: タイトル'), null, ref);
  }
});

type Call = { command: string; args: string[] };

function harness(title?: string | null) {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const deps = {
    platform: 'win32' as NodeJS.Platform,
    env: { ORCA_CLI_COMMAND: 'fake-orca' },
    run: (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0, stdout: '{"ok":true}', stderr: '' } as never;
    },
    warn: (m: string) => void warnings.push(m),
    ...(title === undefined ? {} : { title }),
  };
  return { calls, warnings, deps };
}

const displayNameOf = (args: string[]) => args[args.indexOf('--display-name') + 1];

test('labelOrcaWorktree：deps.title があれば --display-name はタイトル由来になる', () => {
  const h = harness('feat(harness): Orca の表示名を日本語にする');
  assert.equal(labelOrcaWorktree(PATH, REF, h.deps), 'labeled');
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0]!.args, orcaWorktreeSetArgs(PATH, { issue: 592, displayName: '#592 Orca の表示名を日本語にする' }));
  assert.deepEqual(h.warnings, []);
});

test('labelOrcaWorktree：deps.title が無い・null・空白だけなら今の表示名（ブランチの後ろ）で付け、止まらない', () => {
  for (const title of [undefined, null, '   ']) {
    const h = harness(title);
    assert.equal(labelOrcaWorktree(PATH, REF, h.deps), 'labeled', JSON.stringify(title));
    assert.equal(h.calls.length, 1, JSON.stringify(title));
    assert.equal(displayNameOf(h.calls[0]!.args), '#592 orca-title', JSON.stringify(title));
    assert.deepEqual(h.warnings, [], JSON.stringify(title));
  }
});

test('labelOrcaWorktree：形に合わないブランチはタイトルがあっても skipped で、CLI を呼ばない', () => {
  const h = harness('feat: タイトル');
  assert.equal(labelOrcaWorktree(PATH, 'main', h.deps), 'skipped');
  assert.deepEqual(h.calls, []);
});
