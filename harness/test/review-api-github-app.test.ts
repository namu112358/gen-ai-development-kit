// review-api の GitHub App の JWT と installation token（review-api/src/github-app.ts）が、PKCS#1 の鍵を PKCS#8 に包み、
// PKCS#1・PKCS#8・文字の \n の PEM で RS256 の JWT を作り、知らない PEM で投げ、偽の fetch に正しい要求を送り、失敗の Error に JWT を入れないことを確かめる（Issue #879）
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { READ_PERMISSIONS, WRITE_PERMISSIONS, appJwt, installationToken, pemToDer, pkcs1ToPkcs8 } from '../../review-api/src/github-app.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs1Pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const pkcs8Pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

test('pkcs1ToPkcs8 は PKCS#1 の DER を PKCS#8 の DER の export と同じバイトに包む', () => {
  const pkcs1Der = privateKey.export({ type: 'pkcs1', format: 'der' });
  const pkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
  assert.deepEqual(Buffer.from(pkcs1ToPkcs8(new Uint8Array(pkcs1Der))), pkcs8Der);
});

test('PKCS#1・PKCS#8・文字の \\n の PEM で、RS256 のヘッダー・iss・iat・exp と検証できる署名の JWT を作る', async () => {
  const nowMs = 1_700_000_000_500;
  const now = Math.floor(nowMs / 1000);
  const cases = [
    { name: 'PKCS#1', pem: pkcs1Pem, kind: 'pkcs1' },
    { name: 'PKCS#8', pem: pkcs8Pem, kind: 'pkcs8' },
    { name: '文字の \\n の PKCS#1', pem: pkcs1Pem.replace(/\n/g, '\\n'), kind: 'pkcs1' },
  ] as const;
  for (const { name, pem, kind } of cases) {
    assert.equal(pemToDer(pem).kind, kind, name);
    const jwt = await appJwt('Iv1.client', pem, nowMs);
    const [h, p, s] = jwt.split('.');
    assert.ok(h && p && s, name);
    assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' }, name);
    assert.deepEqual(JSON.parse(Buffer.from(p, 'base64url').toString()), { iat: now - 60, exp: now + 540, iss: 'Iv1.client' }, name);
    const verifier = createVerify('RSA-SHA256').update(`${h}.${p}`);
    assert.ok(verifier.verify(publicKey, Buffer.from(s, 'base64url')), `${name} の署名が検証できない`);
  }
});

test('知らない PEM（公開鍵・ただの文字列）で pemToDer は投げる', () => {
  for (const pem of [publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'not a pem']) {
    assert.throws(() => pemToDer(pem), Error);
  }
});

test('installationToken は偽の fetch に URL・POST・ヘッダー・permissions を送り、失敗の Error に JWT と応答の本文を入れない', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch = (status: number, body: string) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status });
    }) as typeof fetch;
  const jwt = 'header.payload.signature-secret';
  for (const permissions of [READ_PERMISSIONS, WRITE_PERMISSIONS]) {
    calls.length = 0;
    const ok = fakeFetch(201, JSON.stringify({ token: 'ghs_x', expires_at: '2026-10-12T01:00:00Z' }));
    assert.deepEqual(await installationToken(jwt, 42, permissions, ok), { token: 'ghs_x', expiresAt: '2026-10-12T01:00:00Z' });
    assert.equal(calls.length, 1);
    const { url, init } = calls[0]!;
    assert.equal(url, 'https://api.github.com/app/installations/42/access_tokens');
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${jwt}`);
    assert.equal(headers.get('Accept'), 'application/vnd.github+json');
    assert.equal(headers.get('X-GitHub-Api-Version'), '2022-11-28');
    assert.equal(headers.get('User-Agent'), 'review-api');
    assert.deepEqual(JSON.parse(String(init?.body)), { permissions });
  }
  await assert.rejects(installationToken(jwt, 42, READ_PERMISSIONS, fakeFetch(401, 'BODY-MARKER')), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes('401'), error.message);
    assert.ok(!error.message.includes(jwt) && !error.message.includes('BODY-MARKER'), error.message);
    return true;
  });
});
