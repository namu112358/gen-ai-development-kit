import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Issue #208：.gitattributes で改行コードを LF にそろえる設定と、docs/setup.md の手順の検査

const root = join(import.meta.dirname, '..', '..');

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} が失敗: ${r.stderr}`);
  return r.stdout;
}

// .gitattributes の、コメントと空行を除いた行（前後の空白を落とし、連続する空白を1つにする）
function attributeLines(): string[] {
  const path = join(root, '.gitattributes');
  assert.ok(existsSync(path), '.gitattributes が無い');
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

// `git check-attr <attrs> -- <paths>` の出力を「パス → 属性 → 値」にする
function checkAttr(attrs: string[], paths: string[]): Map<string, Map<string, string>> {
  const out = git(['check-attr', ...attrs, '--', ...paths]);
  const result = new Map<string, Map<string, string>>();
  for (const line of out.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const m = /^(.*): ([^:]+): (.*)$/.exec(line);
    assert.ok(m, `check-attr の出力を読めない: ${line}`);
    const path = m[1] ?? '';
    const attr = m[2] ?? '';
    const value = m[3] ?? '';
    if (!result.has(path)) result.set(path, new Map());
    result.get(path)!.set(attr, value);
  }
  return result;
}

test('.gitattributes に「* text=auto eol=lf」の行がある', () => {
  const lines = attributeLines();
  assert.ok(lines.includes('* text=auto eol=lf'), `「* text=auto eol=lf」の行が無い: ${JSON.stringify(lines)}`);
});

test('.gitattributes で *.bat・*.cmd は eol=crlf', () => {
  const lines = attributeLines();
  for (const pattern of ['*.bat', '*.cmd']) {
    const line = lines.find((l) => l.split(' ')[0] === pattern);
    assert.ok(line, `${pattern} の行が無い`);
    assert.ok(line.split(' ').includes('eol=crlf'), `${pattern} の行に eol=crlf が無い: ${line}`);
  }
  // 属性の上でも crlf になる（存在しないパスでよい）
  const attrs = checkAttr(['eol'], ['x.bat', 'x.cmd']);
  for (const path of ['x.bat', 'x.cmd']) {
    assert.equal(attrs.get(path)?.get('eol'), 'crlf', `${path} の eol が crlf でない`);
  }
});

test('主なテキストファイルは text: auto・eol: lf で取り出される', () => {
  const paths = ['CLAUDE.md', 'harness/lib/plan.ts', 'docs/setup.md', 'package.json', 'overview.html'];
  const attrs = checkAttr(['text', 'eol'], paths);
  for (const path of paths) {
    assert.equal(attrs.get(path)?.get('text'), 'auto', `${path} の text が auto でない`);
    assert.equal(attrs.get(path)?.get('eol'), 'lf', `${path} の eol が lf でない`);
  }
});

test('index に CRLF・混在の改行のファイルが無い', () => {
  const out = git(['ls-files', '--eol']);
  const bad: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const index = line.split(/\s+/)[0];
    if (index === 'i/crlf' || index === 'i/mixed') bad.push(line);
  }
  assert.deepEqual(bad, [], `index に CRLF・混在のファイルがある:\n${bad.join('\n')}`);
});

test('docs/setup.md の「## 10. 改行コード」の節に、既存の checkout をそろえる手順がある', () => {
  const text = readFileSync(join(root, 'docs', 'setup.md'), 'utf8');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## 10. 改行コード'));
  assert.ok(start !== -1, 'docs/setup.md に「## 10. 改行コード」の節が無い');
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  const section = lines.slice(start, end).join('\n');
  for (const cmd of ['git add --renormalize .', 'git ls-files --eol', 'git reset --hard']) {
    assert.ok(section.includes(cmd), `「## 10. 改行コード」の節に \`${cmd}\` が無い`);
  }
});
