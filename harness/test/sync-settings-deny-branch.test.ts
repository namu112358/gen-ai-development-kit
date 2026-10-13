// sync が配る permissions.deny の既定ブランチへの push の3行を、導入先の defaultBranch で作ることを確かめる（Issue #868）。
// planSync の merge の結果（develop の3行があり main の3行が無い／置き場所の無い古い kit は kit の settings の deny）と、
// sync の CLI が導入先の defaultBranch が空なら kit を取り込む前に終了コード 1 で止まり .claude/settings.json を書かないことを見る。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { planSync, type SyncInput } from '../lib/sync.ts';

const root = join(import.meta.dirname, '..', '..');
const TEMPLATE_PATH = 'harness/templates/claude-settings.deny.json';
const enc = (v: unknown): Uint8Array => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v));
const KIT_SETTINGS = { permissions: { deny: ['Bash(kit-deny)'] } };

const pushLines = (b: string) => [`Bash(git push * ${b})`, `Bash(git push * *:${b})`, `Bash(git push * HEAD:${b})`];

const input = (kitFiles: Map<string, Uint8Array>, targetDefaultBranch: string): SyncInput => ({
  managed: { managed: ['harness/templates/**'], exclude: [], projectOwned: [], settingsKeys: ['permissions.deny'], settingsAllow: [] },
  local: null,
  kitFiles: new Map([['.claude/settings.json', enc(KIT_SETTINGS)], ...kitFiles]),
  targetList: () => [],
  targetRead: () => null,
  targetSettings: null,
  kit: { repository: 'o/kit', ref: 'v1', sha: '0'.repeat(40) },
  now: new Date('2026-10-13T00:00:00.000Z'),
  prune: false,
  targetDefaultBranch,
});

const denyOfPlan = (i: SyncInput): string[] => (planSync(i).settings.merged as { permissions: { deny: string[] } }).permissions.deny;

test('defaultBranch が develop の導入先では、merge した deny に develop への push の3行があり main への push の3行が無い', () => {
  const deny = denyOfPlan(input(new Map([[TEMPLATE_PATH, enc(readFileSync(join(root, TEMPLATE_PATH), 'utf8'))]]), 'develop'));
  assert.deepEqual(pushLines('develop').filter((r) => !deny.includes(r)), [], 'develop の3行が足りない');
  assert.deepEqual(pushLines('main').filter((r) => deny.includes(r)), [], 'main の3行が残っている');
});

test('雛形に {{defaultBranch}} が無い（古い）kit では kit の .claude/settings.json の deny を使う', () => {
  const cases: [string, Map<string, Uint8Array>][] = [
    ['雛形が無い', new Map()],
    ['雛形に置き場所が無い', new Map([[TEMPLATE_PATH, enc({ permissions: { deny: ['Bash(git push * main)'] } })]])],
  ];
  for (const [name, files] of cases) assert.deepEqual(denyOfPlan(input(files, 'develop')), KIT_SETTINGS.permissions.deny, name);
});

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

test('sync の CLI は導入先の defaultBranch が空なら、kit を取り込む前に終了コード 1 で止まり .claude/settings.json を書かない', () => {
  const target = mkdtempSync(join(tmpdir(), 'sync-deny-branch-'));
  tmpDirs.push(target);
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: target }).status, 0);
  writeFileSync(join(target, 'harness.config.json'), JSON.stringify({ defaultBranch: '' }));
  // --from は存在しない kit。defaultBranch の検査が kit の取り込みより前なら、取り込みの失敗に届かない
  const r = spawnSync(process.execPath, [join(root, 'harness/scripts/sync.ts'), 'v1', '--from', 'file:///nonexistent/kit-868'], {
    cwd: target,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.ok(r.stderr.includes('defaultBranch'), `標準エラーに defaultBranch がありません:\n${r.stderr}`);
  assert.ok(!r.stderr.includes('取り込めません'), `kit の取り込みより前に止まっていません:\n${r.stderr}`);
  assert.ok(!existsSync(join(target, '.claude', 'settings.json')));
});
