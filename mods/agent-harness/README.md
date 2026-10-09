# agent-harness（Claude Code の mod）

hq・fleet の状況を Claude Code の画面に出す mod。

- fleet の status line：collect のスナップショットがあるセッション（fleet）だけ、「fleet #508 実装 · #517 ゲート（人）」のように Issue と段階を1行で出す（`panes.ts line` を15秒ごとに読む。古ければ末尾に更新の時刻）。
- hq の人待ち：プロンプトの上の帯に「hq の人待ち N 件（/hq-todo で開く）」（1件以上のときだけ）。`/hq-todo` で全文をペインに出す。
- hq の人待ちの通知：人待ちが増えたら OS の通知を1回（出せなければ toast）。hq と intel の両方で開いていても1回。止めるには設定 `notifyHqTodo` を false（`/config`。変えるとその場から効く）。
- hq の Epic/Issue：`/hq-board` でペインを開き、ボタン（e・i）で Epic と Issue のページを切り替える。終わった Epic・テーマはグレーにして下に回す（消さない）。
- 中身は `node harness/scripts/panes.ts hq todo --json`（人待ち）と `hq board --json`（Epic/Issue。開いたときから）を15秒ごとに読んだもの（GitHub は読まない）。
- 出るセッション：fleet の status line は fleet のセッション（collect のスナップショットがあるセッション。Issue の worktree でも出る）に出る。hq の人待ちの帯・`/hq-todo`・通知は main の checkout で動くセッション（hq・intel）だけに出て、fleet のワークスペース・Issue の worktree では出さず、人待ちの定期の読み直しも始めない。`/hq-board` は呼んだときだけペインを開き、自動では何も出さない（コマンドはどのセッションにもある。使うのは hq・intel）。

## 入れ方

- 試す・開発：`claude --plugin-dir mods/agent-harness`（そのセッションだけ。保存で読み直す）。
- 常に入れる：`/plugin install agent-harness --marketplace <owner>/<repo>`（リポジトリの root の `.claude-plugin/marketplace.json` を使う）。手元のフォルダを marketplace にするなら `claude plugin marketplace add <リポジトリのフォルダ>`。更新は `/reload-plugins`。
- 更新のしかた：`claude plugin marketplace update agent-harness` の後に `claude plugin update agent-harness@agent-harness`（入れ直しは要らない）。
- mod を変えたら `.claude-plugin/plugin.json` の `version` を上げる。上げないと「already at the latest version」になって届かない。`npm run check` が上げ忘れを落とす（CI は履歴が無いので見ない）。

## 機能の足し方

`hooks/<機能>.tsx` に機能を書き、`hooks/register.tsx` に1行足す。mod はフォルダの外を import できないので、`panes.ts` の JSON の型は `types/index.d.ts` に手で写す。

- 同じ plugin の中で、matcher の無い同じイベント（`session.start` など）の hook は1つしか置けない（`claude plugin validate` で初めて分かる）。足すときは matcher（例 `{ isInteractive: true }`、`hooks/fleet-status-line.tsx`・`hooks/hq-notify.tsx` と同じ）を付けて分けるか、今ある hook に足す。

## 確かめ方

```bash
claude plugin validate mods/agent-harness
claude plugin test mods/agent-harness
```

CI には claude が無いので、変えたときは手元で流す。この2つは `npm run check` の対象ではない（版の上げ忘れだけは `npm run check` が見る）。
