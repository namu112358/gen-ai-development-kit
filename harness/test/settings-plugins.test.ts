import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..', '..');

interface MarketplaceEntry {
  source?: { source?: string; repo?: string; ref?: string };
  autoUpdate?: boolean;
}
interface Settings {
  extraKnownMarketplaces?: Record<string, MarketplaceEntry>;
  enabledPlugins?: Record<string, boolean>;
  permissions?: { allow?: string[] };
}

function readSettings(): Settings {
  return JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as Settings;
}

test('extraKnownMarketplaces に typesafe-ai がコミット固定・autoUpdate false で登録されている', () => {
  const settings = readSettings();
  assert.deepEqual(settings.extraKnownMarketplaces?.['typesafe-ai'], {
    source: { source: 'github', repo: 'typesafe-ai/skills', ref: '65a39f393687675ce170e6094757de20370365b9' },
    autoUpdate: false,
  });
});

test('extraKnownMarketplaces に claude-plugins-official がコミット固定・autoUpdate false で登録されている', () => {
  const settings = readSettings();
  assert.deepEqual(settings.extraKnownMarketplaces?.['claude-plugins-official'], {
    source: { source: 'github', repo: 'anthropics/claude-plugins-official', ref: 'fa59bc9037741ecfa131aa27938272605710d7b2' },
    autoUpdate: false,
  });
});

test('enabledPlugins が typesafe・skill-creator・pr-review-toolkit の3件だけと一致する', () => {
  const settings = readSettings();
  assert.deepEqual(settings.enabledPlugins, {
    'typesafe@typesafe-ai': true,
    'skill-creator@claude-plugins-official': true,
    'pr-review-toolkit@claude-plugins-official': true,
  });
});

test('enabledPlugins の各マーケットプレイスが extraKnownMarketplaces に存在し、コミット SHA 固定で autoUpdate が false になっている', () => {
  const settings = readSettings();
  const enabled = settings.enabledPlugins ?? {};
  const marketplaces = settings.extraKnownMarketplaces ?? {};
  const shaPattern = /^[0-9a-f]{40}$/;
  for (const key of Object.keys(enabled)) {
    const marketplaceName = key.split('@')[1];
    assert.ok(marketplaceName, `${key} からマーケットプレイス名が取れません`);
    const entry = marketplaces[marketplaceName as string];
    assert.ok(entry, `${key} のマーケットプレイス ${marketplaceName} が extraKnownMarketplaces にありません`);
    assert.match(entry?.source?.ref ?? '', shaPattern, `${marketplaceName} の ref がコミット SHA（40桁の16進）ではありません`);
    assert.equal(entry?.autoUpdate, false, `${marketplaceName} の autoUpdate が false ではありません`);
  }
});

test('permissions.allow の WebFetch は docs.typesafe.ai だけで、ワイルドカードや素の WebFetch がない', () => {
  const settings = readSettings();
  const webFetchRules = (settings.permissions?.allow ?? []).filter((rule) => rule.startsWith('WebFetch'));
  assert.deepEqual(webFetchRules, ['WebFetch(domain:docs.typesafe.ai)']);
});

test('reviewer・risk-agent・plan-critic の tools に WebFetch が含まれていない（現状維持の確認）', () => {
  for (const name of ['reviewer', 'risk-agent', 'plan-critic']) {
    const text = readFileSync(join(root, '.claude', 'agents', `${name}.md`), 'utf8');
    const match = text.match(/^tools:\s*(.+)$/m);
    assert.ok(match, `${name}.md に tools 行がありません`);
    const tools = (match?.[1] ?? '').split(',').map((t) => t.trim());
    assert.ok(!tools.includes('WebFetch'), `${name}.md の tools に WebFetch が含まれています`);
  }
});
