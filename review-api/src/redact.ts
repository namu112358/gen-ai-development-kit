// review-api のログ・コメントから、鍵と token を伏せる redact。harness/lib/jev.ts の redact と同じ規則を持つ。
// 先に PEM の秘密鍵のブロックを伏せ（一覧に無くても）、次に4文字以上の秘密を *** にする。import は書かない（Node と Workers の両方で型検査が通るように）。

const PEM_PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function redact(text: string, secrets: (string | undefined)[]): string {
  let out = text.replace(PEM_PRIVATE_KEY_BLOCK, '***');
  for (const s of secrets) {
    if (s !== undefined && s.length >= 4) out = out.split(s).join('***');
  }
  return out;
}
