// Issue #528：plan-critic に、origin/main の最新を含むリポジトリのパスを渡す。fleet のワークスペース（main より古い checkout）から批評しても、
// criticRepo が先に fetch して、HEAD が origin/main を含む読み先（Issue のブランチの worktree → 今の作業ディレクトリ → 無ければ origin/main の SHA の
// detach の worktree）を選ぶか。fetch に失敗したら批評を始める前に止める（投げる）か。renderCriticInput が「=== 読み先のリポジトリ」の節を書くか。
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderCriticInput } from '../lib/session-inputs.ts';
import { criticRepo } from '../lib/worktree.ts';
import { sandbox } from './support/git-sandbox.ts';

type Sb = ReturnType<typeof sandbox>;

const same = (a: string, b: string) => assert.equal(realpathSync.native(a), realpathSync.native(b));

/** 砂場と、worktree の置き場所を砂場の下にした opts */
function setup(t: { after: (fn: () => void) => void }) {
  const sb = sandbox();
  t.after(sb.cleanup);
  const opts = { ...sb.opts, worktreeRoot: join(sb.dir, 'wt') };
  return { sb, opts };
}

/** origin を seed から1つ進める（本体は fetch もしない）。進めた後の origin/main の SHA を返す */
function advanceOrigin(sb: Sb, file: string): string {
  const sha = sb.commit(sb.seed, file);
  sb.git(sb.seed, 'push', '-q', 'origin', 'main');
  return sha;
}

/** 本体から Issue のブランチの worktree を origin/main（本体が最後に fetch した時点）から作る */
function issueWorktree(sb: Sb, branch: string, name: string): string {
  const path = join(sb.dir, name);
  sb.git(sb.root, 'fetch', '-q', 'origin');
  sb.git(sb.root, 'worktree', 'add', '-q', '-b', branch, path, 'origin/main');
  return path;
}

test('本体（cwd）が origin/main より古く、Issue のブランチの worktree が最新 → その worktree を読み先にする', (t) => {
  const { sb, opts } = setup(t);
  const base = advanceOrigin(sb, 'b.txt');
  const wt = issueWorktree(sb, 'claude/issue-528-x', 'issue-wt');
  assert.notEqual(sb.git(sb.root, 'rev-parse', 'HEAD'), base, '本体は古いまま');

  const r = criticRepo(528, sb.root, opts);
  same(r.path, wt);
  assert.equal(r.base, base);
  assert.equal(r.branch, 'main');
  assert.equal(r.source, 'issue-worktree');
});

test('本体が古く、最新を含む Issue の worktree が無い → origin/main の SHA の detach の worktree を作って読み先にする（2回目も同じパス）', async (t) => {
  // before は origin が進む前、after は進んだ後に作るもの
  const cases: { name: string; before?: (sb: Sb) => void; after?: (sb: Sb) => void }[] = [
    { name: 'Issue の worktree が無い' },
    // origin が進む前に作った worktree は最新を含まない
    { name: 'Issue の worktree が古い', before: (sb) => void issueWorktree(sb, 'claude/issue-528-old', 'issue-old') },
    // 番号の前方一致（#5280）は Issue のブランチとみなさない（最新を含んでいても使わない）
    { name: '別の Issue（#5280）の worktree だけが最新', after: (sb) => void issueWorktree(sb, 'claude/issue-5280-x', 'other-wt') },
  ];
  for (const c of cases) {
    await t.test(c.name, (tt) => {
      const { sb, opts } = setup(tt);
      c.before?.(sb);
      const base = advanceOrigin(sb, 'b.txt');
      c.after?.(sb);

      const r = criticRepo(528, sb.root, opts);
      assert.equal(r.source, 'snapshot');
      assert.equal(r.base, base, '先に fetch して origin/main の最新を読む');
      assert.equal(sb.git(r.path, 'rev-parse', 'HEAD'), base, 'detach の worktree の HEAD は base');
      assert.equal(realpathSync.native(r.path).startsWith(realpathSync.native(opts.worktreeRoot)), true, '置き場所は worktreeRoot の下');

      const again = criticRepo(528, sb.root, opts);
      same(again.path, r.path);
      assert.equal(again.source, 'snapshot');
    });
  }
});

test('本体が最新 → 本体（cwd の toplevel）を読み先にする。cwd がサブディレクトリでも toplevel', (t) => {
  const { sb, opts } = setup(t);
  const base = advanceOrigin(sb, 'b.txt');
  sb.git(sb.root, 'pull', '-q', '--ff-only');
  const sub = join(sb.root, 'sub');
  mkdirSync(sub);

  for (const cwd of [sb.root, sub]) {
    const r = criticRepo(528, cwd, opts);
    same(r.path, sb.root);
    assert.equal(r.base, base);
    assert.equal(r.source, 'cwd');
  }
});

test('fetch に失敗する（origin が無い）→ 本体が最新でも投げる（批評を始める前に止める）', (t) => {
  const { sb, opts } = setup(t);
  sb.git(sb.root, 'remote', 'set-url', 'origin', join(sb.dir, 'missing.git'));
  assert.throws(() => criticRepo(528, sb.root, opts), /最新を読めるパスがありません/);
});

test('renderCriticInput：repo を渡すと「=== 計画」の前に「=== 読み先のリポジトリ」の節（パスと base）。渡さなければ節が無い', () => {
  const issue = { number: 528, title: 't', body: 'B' };
  const repo = { path: '/tmp/wt/abc123', base: 'abc123def', branch: 'main' };
  const text = renderCriticInput(issue, [], 'P', undefined, repo);
  const at = text.indexOf('=== 読み先のリポジトリ');
  assert.ok(at >= 0, '節がある');
  assert.ok(at < text.indexOf('=== 計画'), '計画の前');
  const section = text.slice(at, text.indexOf('=== 計画'));
  assert.ok(section.includes(repo.path));
  assert.ok(section.includes(`origin/main ${repo.base}`));

  assert.ok(!renderCriticInput(issue, [], 'P').includes('読み先のリポジトリ'));
});
