// hq の skill を本体と参照用のファイルに分けたことを確かめる（Issue #1000。Epic #994 で長い SKILL.md の節を分けた）。
// .claude/skills/hq/references/*.md が1つ以上あることと、hq の SKILL.md の字数の上限を見る
// （リンクと配る一覧は全 skill に掛かる skills-references.test.ts が見る）。
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { ROOT, readText } from './support/skill-text.ts';

const HQ = '.claude/skills/hq';

test('hq-skill-references：hq に参照用のファイルが1つ以上ある', () => {
  const dir = join(ROOT, HQ, 'references');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
  assert.ok(files.length > 0, `${HQ}/references/*.md がありません`);
});

test('hq-skill-references：hq の SKILL.md は 23,335 字以下', () => {
  const length = [...readText(`${HQ}/SKILL.md`)].length;
  assert.ok(length <= 23335, `hq の SKILL.md が ${length} 字（上限 23,335 字）`);
});
