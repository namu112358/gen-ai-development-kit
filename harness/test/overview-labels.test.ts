import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Issue #132：overview.html のラベル表示と harness.config.json のラベル定義の食い違いを検査する（AC3）
import { labelsInOverview, checkOverviewLabels } from '../scripts/readme.ts';
import { loadConfig, allLabelDefs } from '../lib/config.ts';

const root = join(import.meta.dirname, '..', '..');

// ---- 単体：<code> の中のラベルの抽出 ----

test('labelsInOverview：<code> 要素の中の 接頭辞:名前 と epic を拾う', () => {
  const html = ['<p><code>agent:ready</code> を付ける。<code>epic</code> も付く。</p>'].join('\n');
  assert.deepEqual(labelsInOverview(html), ['agent:ready', 'epic']);
});

test('labelsInOverview：<code> の外の文字列（CSS セレクタなど）は拾わない', () => {
  const html = ['<style>td:first-child { color: red; }</style>', '<p><code>risk:low</code></p>'].join('\n');
  assert.deepEqual(labelsInOverview(html), ['risk:low']);
});

test('labelsInOverview：管理する接頭辞（MANAGED_PREFIXES）以外の 接頭辞:名前 は拾わない', () => {
  const html = '<p><code>foo:bar</code> と <code>agent:ready</code></p>';
  assert.deepEqual(labelsInOverview(html), ['agent:ready']);
});

// ---- 単体：checkOverviewLabels ----

test('checkOverviewLabels：設定に無いラベルを報告する', () => {
  const html = '<p><code>agent:foo</code></p><h2 id="labels">ラベルの意味</h2><p><code>agent:foo</code></p>';
  const result = checkOverviewLabels(html, [{ name: 'agent:ready' }]);
  assert.deepEqual(result.unknownOnPage, ['agent:foo']);
});

test('checkOverviewLabels：設定のラベルがラベルの意味の節に無ければ報告する', () => {
  const html = '<h2 id="labels">ラベルの意味</h2><p><code>agent:ready</code></p><p>ここには無い</p>';
  const result = checkOverviewLabels(html, [{ name: 'agent:ready' }, { name: 'agent:blocked' }]);
  assert.deepEqual(result.missingFromSection, ['agent:blocked']);
});

test('checkOverviewLabels：risk:* はページ上で risk:low などをまとめて覆う', () => {
  const html = '<h2 id="labels">ラベルの意味</h2><p><code>risk:*</code></p>';
  const defs = [{ name: 'risk:low' }, { name: 'risk:medium' }, { name: 'risk:high' }, { name: 'risk:critical' }];
  const result = checkOverviewLabels(html, defs);
  assert.deepEqual(result.unknownOnPage, []);
  assert.deepEqual(result.missingFromSection, []);
});

test('checkOverviewLabels：risk:* がページにあっても、設定にその接頭辞のラベルが1つも無ければ食い違う', () => {
  const html = '<h2 id="labels">ラベルの意味</h2><p><code>risk:*</code></p>';
  const result = checkOverviewLabels(html, [{ name: 'agent:ready' }]);
  assert.ok(result.unknownOnPage.includes('risk:*') || result.unknownOnPage.length > 0, 'risk:* が設定のどのラベルにも当たらないことを報告する');
});

test('checkOverviewLabels：<code> の外の td:first-child のような文字列は誤検出しない', () => {
  const html = ['<style>table td:first-child{width:1px}</style>', '<h2 id="labels">ラベルの意味</h2>', '<p><code>agent:ready</code></p>'].join('\n');
  const result = checkOverviewLabels(html, [{ name: 'agent:ready' }]);
  assert.deepEqual(result.unknownOnPage, []);
  assert.deepEqual(result.missingFromSection, []);
});

// ---- 実リポジトリに対する検査（AC3） ----

test('実リポジトリ：overview.html と allLabelDefs(loadConfig()) が食い違わない（AC3）', () => {
  const html = readFileSync(join(root, 'overview.html'), 'utf8');
  const defs = allLabelDefs(loadConfig());
  const result = checkOverviewLabels(html, defs);
  assert.deepEqual(result.unknownOnPage, [], `設定に無いラベルがページにある: ${result.unknownOnPage.join(', ')}`);
  assert.deepEqual(result.missingFromSection, [], `ラベルの意味の節に無い設定のラベルがある: ${result.missingFromSection.join(', ')}`);
});
