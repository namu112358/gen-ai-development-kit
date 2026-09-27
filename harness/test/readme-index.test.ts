import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Issue #124：各ディレクトリの README と overview.html の検査

const root = join(import.meta.dirname, '..', '..');

// 説明を置く対象のディレクトリ（14）
const dirs = [
  'harness',
  'harness/lib',
  'harness/gates',
  'harness/scripts',
  'harness/templates',
  'harness/test',
  'harness/test/support',
  '.claude',
  '.claude/agents',
  '.claude/skills',
  '.claude/hooks',
  '.github',
  '.github/workflows',
  'docs',
];

// .github は README.md を置かず、root の README.md の節で説明する
const sectionInRoot = '.github';
// harness/test は直下の名前をすべて並べる検査から外す
const skipListing = new Set(['harness/test']);

function lsFiles(path: string): string[] {
  const r = spawnSync('git', ['ls-files', '-z', '--', path], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ls-files が失敗: ${r.stderr}`);
  return r.stdout.split('\0').filter((p) => p.length > 0);
}

// git 管理下のファイルから、dir の直下の名前（ディレクトリは「名前/」）を集める
function directChildren(dir: string): string[] {
  const prefix = `${dir}/`;
  const names = new Set<string>();
  for (const p of lsFiles(dir)) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const i = rest.indexOf('/');
    names.add(i === -1 ? rest : `${rest.slice(0, i)}/`);
  }
  names.delete('README.md');
  return [...names].sort();
}

function readRootReadme(): string {
  const path = join(root, 'README.md');
  assert.ok(existsSync(path), 'root の README.md が無い');
  return readFileSync(path, 'utf8');
}

// root の README.md から「`.github/`」を含む `## ` 見出しの節を取り出す（次の `## ` 見出しまで）
function githubSection(readme: string): string | undefined {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^## .*`\.github\/`/.test(l));
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function descriptionOf(dir: string): string {
  if (dir === sectionInRoot) {
    const section = githubSection(readRootReadme());
    assert.ok(section !== undefined, 'root の README.md に「`.github/`」の節が無い');
    return section;
  }
  const path = join(root, dir, 'README.md');
  assert.ok(existsSync(path), `${dir}/README.md が無い`);
  return readFileSync(path, 'utf8');
}

function mentioned(text: string, name: string): boolean {
  const bare = name.endsWith('/') ? name.slice(0, -1) : name;
  return text.includes(`\`${bare}\``) || text.includes(`\`${bare}/\``);
}

// 外部の読み込み（に当たる書き方）を探す。見つかったものの説明を返す
const externalPatterns: Array<[string, RegExp]> = [
  ['<script src>', /<script\b[^>]*\bsrc\s*=/i],
  ['<link>', /<link\b/i],
  ['メディア要素の src/srcset/data', /<(?:img|source|iframe|video|audio|object|embed)\b[^>]*\b(?:src|srcset|data)\s*=/i],
  ['srcset', /\bsrcset\s*=/i],
  ['<base href>', /<base\b[^>]*\bhref\s*=/i],
  ['<meta http-equiv="refresh">', /<meta\b[^>]*\bhttp-equiv\s*=\s*["']?\s*refresh/i],
  ['<form action>', /<form\b[^>]*\baction\s*=/i],
  ['CSS の url(', /\burl\s*\(/i],
  ['CSS の @import', /@import\b/i],
  ['data: URI', /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i],
];

function findExternalLoads(html: string): string[] {
  return externalPatterns.filter(([, re]) => re.test(html)).map(([label]) => label);
}

test('外部の読み込みの検出：禁止する書き方をすべて検出する', () => {
  const bad = [
    '<img src="https://x/y.png">',
    '<IMG SRC="https://x/y.png">',
    '<link rel="stylesheet" href="a.css">',
    '<link rel="icon" href="favicon.ico">',
    '<style>div{background:url(x.png)}</style>',
    '<style>@import "a.css";</style>',
    '<script src="a.js"></script>',
    '<iframe src="https://example.com"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<picture><source srcset="a.webp"></picture>',
    '<video src="a.mp4"></video>',
    '<audio src="a.mp3"></audio>',
    '<object data="a.svg"></object>',
    '<embed src="a.swf">',
    '<div srcset="a.png"></div>',
    '<base href="https://example.com/">',
    '<form action="https://example.com/post"></form>',
    '<a href="data:text/html;base64,AAAA">x</a>',
  ];
  for (const html of bad) assert.ok(findExternalLoads(html).length > 0, `検出すべき: ${html}`);
});

test('外部の読み込みの検出：許す書き方は検出しない', () => {
  const ok = [
    '<a href="https://example.com">リンク</a>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    '<script>document.body.dataset.x = "1";</script>',
    '<style>body{color:#333}</style>',
    '<div data-role="box">metadata: 説明</div>',
  ];
  for (const html of ok) assert.deepEqual(findExternalLoads(html), [], `検出すべきでない: ${html}`);
});

test('.github を除く対象ディレクトリすべてに README.md がある', () => {
  const missing = dirs.filter((d) => d !== sectionInRoot && !existsSync(join(root, d, 'README.md')));
  assert.deepEqual(missing, [], `README.md が無い: ${missing.join(', ')}`);
});

test('root の README.md に .github の説明の節（「`.github/`」を含む ## 見出し）がある', () => {
  assert.ok(githubSection(readRootReadme()) !== undefined, 'root の README.md に「`.github/`」の節が無い');
});

for (const dir of dirs) {
  if (skipListing.has(dir)) continue;
  const where = dir === sectionInRoot ? 'root の README.md の「`.github/`」節' : `${dir}/README.md`;
  test(`${where} に ${dir} 直下の名前がすべてバッククォート付きで書かれている`, () => {
    const children = directChildren(dir);
    assert.ok(children.length > 0, `${dir} の直下に git 管理下のものが無い`);
    const text = descriptionOf(dir);
    const missing = children.filter((name) => !mentioned(text, name));
    assert.deepEqual(missing, [], `${where} に無い名前: ${missing.join(', ')}`);
  });
}

test('overview.html が git 管理下にあり、外部の読み込みが無い', () => {
  assert.ok(lsFiles('overview.html').includes('overview.html'), 'overview.html が git 管理下に無い');
  const html = readFileSync(join(root, 'overview.html'), 'utf8');
  const found = findExternalLoads(html);
  assert.deepEqual(found, [], `overview.html に外部の読み込みがある: ${found.join(', ')}`);
});

test('root の README.md から overview.html へのリンクがある', () => {
  assert.ok(readRootReadme().includes('](overview.html)'), 'root の README.md に ](overview.html) のリンクが無い');
});
