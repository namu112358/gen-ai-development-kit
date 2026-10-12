// review-api の伏せ字（review-api/src/redact.ts）が、秘密の一覧（複数・繰り返し。undefined と4文字未満は無視）と、
// 一覧に無い PEM の秘密鍵のブロックを *** に置き換えることを確かめる（Issue #879）
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { redact } from '../../review-api/src/redact.ts';

test('秘密を複数・繰り返しとも *** にし、undefined と4文字未満は無視する', () => {
  const text = 'a=ghs_token1 b=secretB again=ghs_token1 short=abc';
  assert.equal(redact(text, ['ghs_token1', 'secretB', undefined, 'abc']), 'a=*** b=*** again=*** short=abc');
});

test('一覧に無い PEM の秘密鍵のブロックを伏せ、前後の文字は残す', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  for (const type of ['pkcs1', 'pkcs8'] as const) {
    const pem = privateKey.export({ type, format: 'pem' }).toString().trim();
    const out = redact(`before ${pem} after`, []);
    assert.equal(out, 'before *** after', type);
    assert.ok(!out.includes('BEGIN') && !out.includes(pem.split('\n')[1]!), type);
  }
});
