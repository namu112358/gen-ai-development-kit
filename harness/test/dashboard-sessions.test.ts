// Issue #176：手元のセッション記録（~/.claude/projects の jsonl とサブエージェントの meta.json）の読み取り
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isRepoProjectDir, issueFromBranch, projectDirName, readSessions } from '../scripts/dashboard/sessions.ts';

// パスは resolve で組み立てる（Windows では '/mnt/c/x/repo' が 'C:\mnt\c\x\repo' になる）
const toDir = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');
const REPO = resolve('/mnt/c/x/repo');
const WT = (name: string) => resolve(REPO, '..', 'repo.worktrees', name);
const WT_PATH = WT('claude-issue-5-a');
const REPO_DIR = toDir(REPO);
const WT_DIR = toDir(WT_PATH);
const OTHER_REPO_DIR = `${REPO_DIR}2`;
const SIBLING_DIR = toDir(resolve(REPO, '..', '..', 'y', 'repo'));
const NOW = new Date('2026-09-29T00:00:00Z');
const at = (msBefore: number) => new Date(NOW.getTime() - msBefore).toISOString();
const SECRET = 'SECRET-CONVERSATION-TEXT';

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const entry = (timestamp: string | undefined, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', ...(timestamp ? { timestamp } : {}), message: { role: 'assistant', content: [{ type: 'text', text: SECRET }] }, ...extra });

function withProjects(fn: (projectsDir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-sessions-'));
  try {
    const projectsDir = join(dir, 'projects');
    mkdirSync(projectsDir);
    fn(projectsDir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const put = (path: string, text: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
};

test('projectDirName：パスの英数字以外を - にする', () => {
  assert.equal(projectDirName('/mnt/c/a.b/c-d'), '-mnt-c-a-b-c-d');
  assert.equal(projectDirName(REPO), REPO_DIR);
  assert.equal(projectDirName(WT_PATH), WT_DIR);
});

test('isRepoProjectDir：リポジトリそのものと worktree の置き場所の下だけ。よく似た別のリポジトリは見ない', () => {
  assert.equal(isRepoProjectDir(REPO_DIR, REPO), true);
  assert.equal(isRepoProjectDir(WT_DIR, REPO), true);
  assert.equal(isRepoProjectDir(OTHER_REPO_DIR, REPO), false);
  assert.equal(isRepoProjectDir(`${REPO_DIR}-other`, REPO), false);
  assert.equal(isRepoProjectDir(`${OTHER_REPO_DIR}-worktrees-claude-issue-5-a`, REPO), false);
  assert.equal(isRepoProjectDir(SIBLING_DIR, REPO), false);
});

test('issueFromBranch：branch の claude/issue-<n>- と cwd の claude-issue-<n>- から番号を読む', () => {
  assert.equal(issueFromBranch('claude/issue-176-graph-dashboard'), 176);
  assert.equal(issueFromBranch('/mnt/c/x/repo.worktrees/claude-issue-42-foo'), 42);
  assert.equal(issueFromBranch('main'), null);
  assert.equal(issueFromBranch('/mnt/c/x/repo'), null);
  assert.equal(issueFromBranch('feature/issue-3-x'), null);
  assert.equal(issueFromBranch(null), null);
});

test('readSessions：最後の timestamp・branch・cwd・issue・running と、サブエージェントの種類・説明・最後の時刻を読む', () => {
  withProjects((projectsDir) => {
    const wt = join(projectsDir, WT_DIR);
    put(join(wt, 'sess-a.jsonl'), [
      entry(at(600_000), { gitBranch: 'main', cwd: REPO }),
      '{ this is not json',
      entry(at(30_000), { gitBranch: 'claude/issue-5-a', cwd: WT_PATH }),
      '',
    ].join('\n'));
    put(join(wt, 'sess-a', 'subagents', 'agent-x1.meta.json'), JSON.stringify({ agentType: 'reviewer', description: 'PR を読む' }));
    put(join(wt, 'sess-a', 'subagents', 'agent-x1.jsonl'), [entry(at(200_000)), entry(at(40_000))].join('\n'));
    put(join(wt, 'sess-a', 'subagents', 'agent-x2.meta.json'), JSON.stringify({ agentType: 'risk-agent', description: '危険度' }));
    put(join(wt, 'sess-a', 'subagents', 'agent-x2.jsonl'), entry(at(3_600_000)));
    // 別のリポジトリの記録は見ない
    put(join(projectsDir, OTHER_REPO_DIR, 'sess-other.jsonl'), entry(at(1000)));

    const got = readSessions({ projectsDir, repoRoot: REPO, now: NOW });
    assert.deepEqual(got.map((s) => s.id), ['sess-a']);
    const s = got[0]!;
    assert.equal(s.lastAt, at(30_000));
    assert.equal(s.branch, 'claude/issue-5-a');
    assert.equal(s.cwd, WT_PATH);
    assert.equal(s.issue, 5);
    assert.equal(s.running, true, '既定の 90 秒以内');
    const subs = [...s.subagents].sort((a, b) => a.type.localeCompare(b.type));
    assert.deepEqual(subs.map((x) => [x.type, x.description, x.lastAt, x.running]), [
      ['reviewer', 'PR を読む', at(40_000), true],
      ['risk-agent', '危険度', at(3_600_000), false],
    ]);
    assert.ok(!JSON.stringify(got).includes(SECRET), '会話の中身を返さない');
  });
});

test('readSessions：cwd だけで issue を読む。activeWindowMs を超えたら running でない', () => {
  withProjects((projectsDir) => {
    put(join(projectsDir, WT_DIR, 'sess-b.jsonl'), entry(at(120_000), { cwd: WT('claude-issue-9-z') }));
    const [s] = readSessions({ projectsDir, repoRoot: REPO, now: NOW });
    assert.ok(s);
    assert.equal(s.branch, null);
    assert.equal(s.issue, 9);
    assert.equal(s.running, false);
    assert.equal(readSessions({ projectsDir, repoRoot: REPO, now: NOW, activeWindowMs: 300_000 })[0]!.running, true);
  });
});

test('readSessions：maxAgeMs（既定 12 時間）より古いセッションは返さない', () => {
  withProjects((projectsDir) => {
    const old = join(projectsDir, REPO_DIR, 'sess-old.jsonl');
    put(old, entry(at(2 * 24 * 3_600_000), { gitBranch: 'main' }));
    const t = new Date(NOW.getTime() - 2 * 24 * 3_600_000);
    utimesSync(old, t, t);
    const recent = join(projectsDir, REPO_DIR, 'sess-new.jsonl');
    put(recent, entry(at(3 * 3_600_000), { gitBranch: 'main' }));
    const r = new Date(NOW.getTime() - 3 * 3_600_000);
    utimesSync(recent, r, r);
    assert.deepEqual(readSessions({ projectsDir, repoRoot: REPO, now: NOW }).map((s) => s.id), ['sess-new']);
    assert.deepEqual(readSessions({ projectsDir, repoRoot: REPO, now: NOW, maxAgeMs: 3_600_000 }).map((s) => s.id), []);
  });
});

test('readSessions：末尾の 64KB の中から最後の timestamp を読む（大きなファイル）', () => {
  withProjects((projectsDir) => {
    const filler = Array.from({ length: 400 }, (_, i) => entry(at(3_600_000 + i), { gitBranch: 'main', pad: 'x'.repeat(500) }));
    put(join(projectsDir, REPO_DIR, 'sess-big.jsonl'), [...filler, entry(at(10_000), { gitBranch: 'claude/issue-7-big' })].join('\n'));
    const [s] = readSessions({ projectsDir, repoRoot: REPO, now: NOW });
    assert.ok(s);
    assert.equal(s.lastAt, at(10_000));
    assert.equal(s.issue, 7);
  });
});

test('readSessions：壊れた行・壊れた meta.json・timestamp の無い記録・無いディレクトリで落ちない', () => {
  assert.deepEqual(readSessions({ projectsDir: join(tmpdir(), 'no-such-dashboard-projects-dir'), repoRoot: REPO, now: NOW }), []);
  withProjects((projectsDir) => {
    const dir = join(projectsDir, REPO_DIR);
    put(join(dir, 'sess-c.jsonl'), ['garbage', '{"x":', entry(at(5_000))].join('\n'));
    put(join(dir, 'sess-c', 'subagents', 'agent-bad.meta.json'), '{ broken');
    put(join(dir, 'sess-c', 'subagents', 'agent-bad.jsonl'), entry(at(5_000)));
    put(join(dir, 'sess-c', 'subagents', 'agent-ok.meta.json'), JSON.stringify({ agentType: 'test-designer', description: 'テスト' }));
    put(join(dir, 'sess-c', 'subagents', 'agent-ok.jsonl'), 'not json at all');
    put(join(dir, 'sess-d.jsonl'), line({ type: 'summary', summary: SECRET }));
    put(join(dir, 'notes.txt'), 'not a session');

    const got = readSessions({ projectsDir, repoRoot: REPO, now: NOW });
    const c = got.find((s) => s.id === 'sess-c');
    assert.ok(c);
    assert.equal(c.lastAt, at(5_000));
    const ok = c.subagents.find((x) => x.type === 'test-designer');
    assert.ok(ok, '壊れていない meta.json のサブエージェントは読む');
    assert.equal(ok.lastAt, null, 'timestamp の無い jsonl は null');
    assert.equal(ok.running, false);
    for (const x of c.subagents) assert.equal(typeof x.type, 'string');
    const d = got.find((s) => s.id === 'sess-d');
    if (d) assert.equal(d.lastAt, null);
    assert.ok(!got.some((s) => s.id === 'notes' || s.id === 'notes.txt'));
    assert.ok(!JSON.stringify(got).includes(SECRET), '会話の中身を返さない');
  });
});
