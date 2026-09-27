import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { claimOf } from '../lib/facts.ts';
import { allLabelDefs, loadConfig, reasonMark, reasonOf } from '../lib/config.ts';
import { renderBlock } from '../lib/blocks.ts';

const config = loadConfig();
const operations = readFileSync(new URL('../../docs/operations.md', import.meta.url), 'utf8');

/** operations.md のラベル表に書かれたラベル（`a` / `b` と `x:*` の形） */
function documentedLabels(): string[] {
  const start = operations.indexOf('## ラベル');
  const table = operations.slice(start, operations.indexOf('\n\n着手中かどうか', start));
  return [...table.matchAll(/^\| ([^|]+) \|/gm)].flatMap((m) => [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!));
}

test('ラベルの定義と operations.md の表が一致する', () => {
  const defs = allLabelDefs(config).map((d) => d.name).filter((n) => n !== config.autoMergeStopLabel);
  const docs = documentedLabels();
  const covered = (name: string) => docs.some((d) => d === name || (d.endsWith(':*') && name.startsWith(d.slice(0, -1))));
  assert.deepEqual(defs.filter((n) => !covered(n)), [], '文書に無い定義');
  const defined = (d: string) => defs.some((n) => n === d || (d.endsWith(':*') && n.startsWith(d.slice(0, -1))));
  assert.deepEqual(docs.filter((d) => !defined(d)), [], '定義に無い文書のラベル');
});

test('理由コードの目印を読める（MCP でエスケープされた形も）', () => {
  assert.equal(reasonOf(`${reasonMark('fix-limit')}\n本文`), 'fix-limit');
  assert.equal(reasonOf('&lt;!-- agent-harness:reason code=external --&gt;'), 'external');
  assert.equal(reasonOf('<!-- agent-harness:reason code=unknown -->'), null);
});

const comment = (body: string) => ({ id: 1, body, html_url: '', created_at: '', updated_at: '', author_association: 'OWNER', user: { login: 'me', type: 'User' } });
const mark = '<!-- agent-harness:claude -->';

test('着手宣言は、解除コメントか、より新しい計画・判定コメントで終わる', () => {
  const claim = comment(`${mark}\n${renderBlock('agent-claim', { by: 'manual', at: '2026-09-27T00:00:00Z' })}`);
  assert.equal(claimOf([claim])?.by, 'manual');
  assert.equal(claimOf([claim, comment(`${mark}\n${renderBlock('agent-plan', {})}`)]), null, '計画を投稿したら終わり');
  assert.equal(claimOf([claim, comment(`${mark}\n${renderBlock('agent-claim', { by: 'manual', at: '2026-09-27T01:00:00Z', released: true })}`)]), null);
});
