// Issue #228：セッションの ID の形の規則（正規表現）が harness/lib/session.ts の TRANSCRIPT_SESSION_ID の1か所だけにあり、
// SessionStart の hook（.claude/hooks/session-env.ts）がそれを import して同じ判断をするか
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { envLine } from '../../.claude/hooks/session-env.ts';
import { TRANSCRIPT_SESSION_ID } from '../lib/session.ts';

const root = join(import.meta.dirname, '..', '..');
const HOOK = join(root, '.claude', 'hooks', 'session-env.ts');

/** ID の形の正規表現の中身。文字列の一致で探すので、\w など別の書き方で書き直したものは検出できない */
const ID_CHARS = '[A-Za-z0-9_-]+';

/**
 * 走査するコードのディレクトリ。harness/test は、テスト自身（このファイル）がこの文字列を持つので対象から外す。
 * docs などコードでないファイルは、説明として書くことがあるので対象にしない。
 */
const SCAN_DIRS = ['.claude/hooks', 'harness/lib', 'harness/scripts', 'harness/gates'];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      out.push(...tsFiles(p));
    } else if (e.isFile() && e.name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

test('ID の形の正規表現は harness/lib/session.ts の1行だけに書かれている', () => {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of tsFiles(join(root, ...d.split('/')))) {
      const rel = relative(root, file).split(sep).join('/');
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (line.includes(ID_CHARS)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
  }
  assert.equal(hits.length, 1, `ID の形の正規表現が1か所ではありません:\n${hits.join('\n')}`);
  assert.match(hits[0] ?? '', /^harness\/lib\/session\.ts:\d+: export const TRANSCRIPT_SESSION_ID = /);
});

test('session-env.ts は harness/lib/session.ts の TRANSCRIPT_SESSION_ID を動的 import で読む', () => {
  const src = readFileSync(HOOK, 'utf8');
  assert.ok(!src.includes(ID_CHARS), 'hook に ID の形の正規表現のリテラルが残っています');
  assert.match(
    src,
    /\{[^}]*\bTRANSCRIPT_SESSION_ID\b[^}]*\}\s*=\s*await\s+import\(\s*['"]\.\.\/\.\.\/harness\/lib\/session\.ts['"]\s*\)/,
    'await import(\'../../harness/lib/session.ts\') から TRANSCRIPT_SESSION_ID を取り出していません',
  );
});

test('session-env.ts の envLine は、TRANSCRIPT_SESSION_ID が読めない（null）ときに null を返す分岐を持つ', () => {
  const src = readFileSync(HOOK, 'utf8');
  // import で受ける名前（`{ TRANSCRIPT_SESSION_ID }` ならそのまま、`{ TRANSCRIPT_SESSION_ID: 別名 }` なら別名）
  const bound = /\{[^}]*\bTRANSCRIPT_SESSION_ID\b(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=\s*await\s+import\(/.exec(src);
  assert.ok(bound, 'TRANSCRIPT_SESSION_ID を import で受けていません');
  const name = bound[1] ?? 'TRANSCRIPT_SESSION_ID';
  const start = src.indexOf('export function envLine(');
  assert.ok(start >= 0, 'envLine が見つかりません');
  const next = src.indexOf('\n}\n', start);
  const body = src.slice(start, next < 0 ? undefined : next);
  const n = name.replace(/\$/g, '\\$');
  assert.match(
    body,
    new RegExp(`if\\s*\\(\\s*(?:!\\s*${n}\\b|${n}\\s*[!=]==?\\s*null\\b|null\\s*[!=]==?\\s*${n}\\b)[^)]*\\)\\s*\\{?\\s*return\\s+null\\b`),
    `envLine に ${name} が null のときに null を返す分岐がありません`,
  );
  assert.match(body, new RegExp(`\\b${n}\\??\\.test\\(`), `envLine が ${name} で ID を確かめていません`);
});

test('envLine が書くかどうかは TRANSCRIPT_SESSION_ID.test(id) と一致する', () => {
  const ids = [
    'abc',
    '3f2a9c1e-0b1d-4c2e-9f00-123456789abc',
    'A_b-9',
    '_',
    '-',
    '',
    'a b',
    'abc; rm -rf /',
    '$(whoami)',
    'x`id`',
    "a'b",
    'a\nexport X=1',
    'abc\n',
    'a.b',
    'a/b',
    'ａｂｃ',
    'é',
  ];
  for (const id of ids) {
    const expected = TRANSCRIPT_SESSION_ID.test(id);
    const line = envLine(JSON.stringify({ session_id: id, hook_event_name: 'SessionStart' }));
    assert.equal(line !== null, expected, `ID ${JSON.stringify(id)}: TRANSCRIPT_SESSION_ID=${expected}, envLine=${JSON.stringify(line)}`);
    if (expected) assert.equal(line, `export AGENT_HARNESS_SESSION=${id}\n`);
  }
});
