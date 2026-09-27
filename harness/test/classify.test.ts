import assert from 'node:assert/strict';
import { test } from 'node:test';
import { areaLabels, classificationChanges, sizeLabel } from '../lib/classify.ts';
import { allLabelDefs, loadConfig } from '../lib/config.ts';

const config = loadConfig();
const f = (filename: string, additions: number, deletions = 0) => ({ filename, additions, deletions });

test('size：追加＋削除の行数。lockfile は数えない', () => {
  assert.equal(sizeLabel(config, [f('docs/a.md', 3)]), 'size:XS');
  assert.equal(sizeLabel(config, [f('src/a.ts', 20, 15)]), 'size:M');
  assert.equal(sizeLabel(config, [f('src/a.ts', 5), f('package-lock.json', 4000)]), 'size:XS');
  assert.equal(sizeLabel(config, [f('src/a.ts', 5000)]), 'size:XXL');
});

test('area：変更ファイルのパスから（重複なし）', () => {
  assert.deepEqual(areaLabels(config, ['docs/a.md', 'README.md', '.github/workflows/ci.yml']), ['area:docs', 'area:harness']);
  assert.deepEqual(areaLabels(config, ['src/app.ts']), []);
});

test('付け外し：size は1つに揃え、area は足すだけ', () => {
  assert.deepEqual(classificationChanges(['size:S', 'area:docs', 'area:other'], 'size:M', ['area:docs']), { add: ['size:M'], remove: ['size:S'] });
  assert.deepEqual(classificationChanges(['size:M'], 'size:M', []), { add: [], remove: [] });
});

test('導入先に作るラベルに size と area が含まれる', () => {
  const names = allLabelDefs(config).map((d) => d.name);
  assert.ok(names.includes('size:XS') && names.includes('size:XXL') && names.includes('area:docs'));
  assert.equal(new Set(names).size, names.length, '重複しない');
});
