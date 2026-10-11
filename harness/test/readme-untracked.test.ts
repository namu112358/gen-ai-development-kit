import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// Issue #661：readme.ts の一覧は、commit 前の新しいファイル（無視されていない未追跡）も入れ、.gitignore に当たるものは入れない
import { writeReadme } from '../scripts/readme.ts';

const dir = mkdtempSync(join(tmpdir(), 'readme-untracked-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const git = (...args: string[]): void => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
const put = (rel: string, content: string): void => writeFileSync(join(dir, ...rel.split('/')), content);

git('init', '-q');
mkdirSync(join(dir, 'lib'));
put('lib/README.md', '# lib\n\n<!-- readme:generated start -->\n<!-- readme:generated end -->\n');
put('lib/tracked.ts', '/** 追跡しているファイル。 */\nexport const a = 1;\n');
put('lib/fresh.ts', '/** commit 前に足したファイル。 */\nexport const b = 2;\n');
put('lib/ignored.ts', '/** 無視するファイル。 */\nexport const c = 3;\n');
put('.gitignore', 'lib/ignored.ts\n');
git('add', 'lib/README.md', 'lib/tracked.ts', '.gitignore');

writeReadme(dir, 'lib');
const readme = readFileSync(join(dir, 'lib', 'README.md'), 'utf8');

test('write：追跡しているファイルに加えて、git add していない新しいファイルも表に入る', () => {
  assert.match(readme, /^\| `tracked\.ts` \|/m);
  assert.match(readme, /^\| `fresh\.ts` \|/m);
});

test('write：.gitignore に当たるファイルは表に入らない', () => {
  assert.doesNotMatch(readme, /`ignored\.ts`/);
});
