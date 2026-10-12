// 信頼できない入力（Issue の本文・PR の本文・diff など）を <untrusted_<label>> で囲む wrapUntrusted。
// 本文中の区切り（<untrusted_・</untrusted_）の < は潰し、囲みを閉じられないようにする。import は書かない（Node と Workers の両方で動く）。

export function wrapUntrusted(label: string, text: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(label)) throw new Error(`不正な label: ${JSON.stringify(label)}`);
  const escaped = text.replace(/<(\/?untrusted_)/gi, '&lt;$1');
  return `<untrusted_${label}>\n${escaped}\n</untrusted_${label}>`;
}
