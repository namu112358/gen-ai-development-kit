# agent-harness（Claude Code の mod）

hq・fleet の状況を Claude Code の画面に出す mod。

- fleet の status line：collect のスナップショットがあるセッション（fleet）だけ、「fleet #508 実装 · #517 ゲート（人）」のように Issue と段階を1行で出す（`panes.ts line` を15秒ごとに読む。古ければ末尾に更新の時刻）。
- hq の人待ち：プロンプトの上の帯に「hq の人待ち N 件（/hq-todo で開く）」（1件以上のときだけ）。`/hq-todo` で全文をペインに出す。
- hq の人待ちの通知：人待ちが増えたら OS の通知を1回（出せなければ toast）。hq と intel の両方で開いていても1回。止めるには設定 `notifyHqTodo` を false（`/config`。変えるとその場から効く）。
- hq の Epic/Issue：`/hq-board` でペインを開き、ボタン（e・i）で Epic と Issue のページを切り替える。終わった Epic・テーマはグレーにして下に回す（消さない）。
- 中身は `node harness/scripts/panes.ts hq todo --json`（人待ち）と `hq board --json`（Epic/Issue。開いたときから）を15秒ごとに読んだもの（GitHub は読まない）。
- hq の人待ちの帯・通知は、main の checkout で動くセッション（hq・intel）だけに出る。fleet のワークスペース・Issue の worktree では何も出さず、定期の読み直しも始めない。

## 入れ方

- 試す・開発：`claude --plugin-dir mods/agent-harness`（そのセッションだけ。保存で読み直す）。
- 常に入れる：`/plugin install agent-harness --marketplace <owner>/<repo>`（リポジトリの root の `.claude-plugin/marketplace.json` を使う）。手元のフォルダを marketplace にするなら `claude plugin marketplace add <リポジトリのフォルダ>`。更新は `/reload-plugins`。

## 機能の足し方

`hooks/<機能>.tsx` に機能を書き、`hooks/register.tsx` に1行足す。mod はフォルダの外を import できないので、`panes.ts` の JSON の型は `types/index.d.ts` に手で写す。

## 確かめ方

```bash
claude plugin validate mods/agent-harness
claude plugin test mods/agent-harness
```

CI には claude が無いので、変えたときは手元で流す。`npm run check` の対象ではない。
