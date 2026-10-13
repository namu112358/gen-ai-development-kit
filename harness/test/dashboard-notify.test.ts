// Issue #1034：ダッシュボードの「人がすること」の件数が増えたときの通知。page.html の noticeTodos が、許可があるときだけ
// 件数が前回より増えたときに Notification を1回作り、開いた直後の件数・同じ件数・許可が無い・Notification が無いでは作らないこと
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { PAGE_PATH } from '../scripts/dashboard.ts';

const html = readFileSync(PAGE_PATH, 'utf8');
const script = (): string => {
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, 'page.html に <script> が無い');
  return m[1]!;
};

interface Made { title: string; body: unknown; tag: unknown }

/** 場合ごとに新しい context で読み、lastTodoCount を初めに戻す。permission が null なら Notification を置かない */
function page(permission: string | null): { notice: (n: number) => void; made: Made[] } {
  const made: Made[] = [];
  const context: Record<string, unknown> = {};
  if (permission !== null) {
    context.Notification = class {
      static permission = permission;
      constructor(title: string, opts: { body?: unknown; tag?: unknown } = {}) {
        made.push({ title: String(title), body: opts.body, tag: opts.tag });
      }
    };
  }
  runInNewContext(script(), context);
  assert.equal(typeof context.noticeTodos, 'function', 'noticeTodos が定義されていない');
  const fn = context.noticeTodos as (list: unknown[]) => void;
  return { notice: (n) => fn(Array.from({ length: n }, (_, i) => ({ key: `t${i}` }))), made };
}

test('noticeTodos：開いた直後の件数では出さず、増えたときに1回だけ出し、同じ件数では増えない', () => {
  const p = page('granted');
  p.notice(2);
  assert.equal(p.made.length, 0);
  p.notice(3);
  assert.deepEqual(p.made, [{ title: '人がすることが増えました', body: '人がすること：2 → 3 件', tag: 'agent-harness-todos' }]);
  p.notice(3);
  assert.equal(p.made.length, 1);
});

for (const permission of ['default', 'denied', null]) {
  test(`noticeTodos：${permission === null ? 'Notification が無い' : `permission が ${permission}`}なら増えても出さず、例外にならない`, () => {
    const p = page(permission);
    p.notice(2);
    p.notice(3);
    assert.equal(p.made.length, 0);
  });
}
