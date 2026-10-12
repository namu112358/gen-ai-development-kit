// review-api の GitHub App の JWT（RS256。PKCS#1 の鍵は PKCS#8 に包む）と installation token の発行。
// WebCrypto・fetch・TextEncoder・atob/btoa だけを使い、import は書かない（Node と Workers の両方で型検査が通り、動くように）。

export const READ_PERMISSIONS = { contents: 'read', pull_requests: 'read', issues: 'read', metadata: 'read' } as const;
export const WRITE_PERMISSIONS = { pull_requests: 'write' } as const;

const PEM_KINDS = [
  { kind: 'pkcs1', label: 'RSA PRIVATE KEY' },
  { kind: 'pkcs8', label: 'PRIVATE KEY' },
] as const;

export function pemToDer(pem: string): { kind: 'pkcs1' | 'pkcs8'; der: Uint8Array } {
  const text = pem.replace(/\\n/g, '\n').trim();
  for (const { kind, label } of PEM_KINDS) {
    const begin = `-----BEGIN ${label}-----`;
    const end = `-----END ${label}-----`;
    if (text.startsWith(begin) && text.endsWith(end)) {
      const body = text.slice(begin.length, text.length - end.length).replace(/\s+/g, '');
      const bin = atob(body);
      const der = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
      return { kind, der };
    }
  }
  throw new Error('unsupported private key PEM (expected RSA PRIVATE KEY or PRIVATE KEY)');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function derLength(n: number): Uint8Array {
  if (n < 128) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, body: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

// SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING(PKCS#1) }
export function pkcs1ToPkcs8(der: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaOid = Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01);
  const algorithm = tlv(0x30, concat(rsaOid, Uint8Array.of(0x05, 0x00)));
  return tlv(0x30, concat(version, algorithm, tlv(0x04, der)));
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function appJwt(clientId: string, pem: string, nowMs: number = Date.now()): Promise<string> {
  const { kind, der } = pemToDer(pem);
  const pkcs8 = kind === 'pkcs1' ? pkcs1ToPkcs8(der) : der;
  const now = Math.floor(nowMs / 1000);
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: clientId })));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    new Uint8Array(pkcs8),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(signingInput));
  return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

export async function installationToken(
  jwt: string,
  installationId: string | number,
  permissions: Record<string, 'read' | 'write'>,
  fetchFn: typeof fetch = fetch,
): Promise<{ token: string; expiresAt: string }> {
  const res = await fetchFn(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'review-api',
    },
    body: JSON.stringify({ permissions }),
  });
  if (!res.ok) throw new Error(`installation token request failed: HTTP ${res.status}`);
  const data: unknown = await res.json();
  const token = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).token : undefined;
  const expiresAt = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).expires_at : undefined;
  if (typeof token !== 'string' || typeof expiresAt !== 'string') throw new Error('installation token response is malformed');
  return { token, expiresAt };
}
