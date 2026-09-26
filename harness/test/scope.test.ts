import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkScope, globToRegExp } from '../lib/scope.ts';

test('glob の意味', () => {
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/lib/a.ts'));
  assert.ok(globToRegExp('src/**').test('src/lib/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/a.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/x/y/a.ts'));
  assert.ok(!globToRegExp('src/a.ts').test('src/a_ts'));
  assert.ok(!globToRegExp('docs/a.md').test('docs/a.md.bak'));
});

test('範囲照合：はみ出したファイルを列挙する', () => {
  assert.deepEqual(checkScope(['src/lib/foo.ts', 'test/**'], ['src/lib/foo.ts', 'test/foo.test.ts']), { ok: true, outside: [] });
  assert.deepEqual(checkScope(['src/lib/foo.ts'], ['src/lib/foo.ts', '.github/workflows/ci.yml', 'package.json']), {
    ok: false,
    outside: ['.github/workflows/ci.yml', 'package.json'],
  });
});
