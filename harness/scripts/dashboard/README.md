# harness/scripts/dashboard/

エージェントの状態をグラフで見る手元のダッシュボード（`harness/scripts/dashboard.ts`）の部品。読み取りだけで、GitHub には書かない。

## 起動

```sh
node harness/scripts/dashboard.ts [--port 4177] [--interval 5]
```

表示された `http://127.0.0.1:<port>/` をブラウザで開く。認証は `GH_TOKEN` / `GITHUB_TOKEN`、無ければ `gh auth token` のトークン。止めるには Ctrl+C。

## 見えるもの

- **段階の層（列）**：計画なし → plan → plan-critique → 計画ゲート待ち → 人の判断待ち → 実装待ち → implement → judge → fix → sync → Merge 待ち。脇に「依存待ち」「止まる印」。有効な着手宣言（`claim --stage`）があればその段階、無ければ `fleet-status` と同じ判断（`harness/lib/fleet.ts` の `fleetStatus`）で決める。
- **列の強制のされ方**：列の上端の線と見出しの印で、その段階がどう強制されているかを示す。コードで必須（太い実線。Ruleset の必須チェックか App のゲートが止める）・条件つき（実線。指摘や衝突があるときだけ）・手順だけ（点線。skill の文章だけで、飛ばしても止まらない）・人（二重線）。見出しの「終了条件」を開くと、終了条件と、飛ばしたときに何が止めるかが読める。
- **注意**：コードで強制されていない手順を飛ばしたカードに出す。計画ゲートの記録の計画に `critique` が無い（「批評なし」）、`revise` で必須の指摘を残して進めた（件数つき）、`critique` の形が崩れている（「批評の記録が読めない」）。
- **状態（カードの左の色）**：着手中・停滞（手動の着手宣言が `humanClaimStaleHours` を超えた）・人待ち・止まっている（hold・blocked・waiting・依存）・衝突（main と衝突）・待機。
- **カード**：Issue と、それに紐付く PR（`Closes #`・Stacked PR の層の `Refs #`）は1枚のカードにまとめ、PR はカードの中の行（番号・状態・着手宣言の段階）で出す。PR に着手宣言の段階があればカードはその段階の列に、状態は Issue と PR の強いほう。Issue の無い PR だけ単独のカード。
- **タスクの層（辺）**：依存（Issue Dependencies）、Epic → 子 Issue、Stacked PR（base が別の開いた PR の head。PR が入ったカードどうしをつなぐ）、タスク → セッション（着手宣言の `session`、または手元のセッションのブランチ）。凡例のチェックで辺の種類ごとに隠せる。
- **カードのセッション**：「N セッション」の折りたたみ。閉じていても、動いているセッションかサブエージェントがあれば点滅する。開くとセッションごとの行とサブエージェント。
- **手元のセッション**：`~/.claude/projects/` のうち、このリポジトリと worktree（`<親>/<名前>.worktrees/`）のセッション記録。最後に動いた時刻と、サブエージェント（plan-critic・reviewer など）の種類と最後に動いた時刻。90 秒以内に動いていれば点滅する。会話の中身は読まない・送らない。

## 更新の仕組み

- GitHub：`/issues?state=all&sort=updated` を条件付きリクエスト（`If-None-Match`）で `--interval` 秒ごとに問い合わせる。304（変化なし）は API の上限に数えられず、組み直しもしない。`updated_at` が変わった Issue / PR（と、それを Closes する側・される側）だけ facts を取り直す。
- セッション記録：`fs.watch` で変化を拾う（2秒ごとにも見直す）。
- ブラウザには Server-Sent Events（`/events`）で、接続時に全体、その後は変わったタスクだけを送る。

## 見えないもの

- ほかの PC やクラウドのセッションの細かい動き（着手宣言の段階とセッションの短い形まで）。
- GitHub の反映の遅れ（数秒）より速い変化。

## 安全

- `127.0.0.1` だけで待ち受け、`Host` が `127.0.0.1:<port>` / `localhost:<port>` でない要求は 403（DNS rebinding で非公開リポジトリの状態を読まれないように）。
- GitHub への要求は `ReadOnlyTransport` を通し、GET と mutation を含まない GraphQL のほかは送らない。トークンはブラウザに送らない。
- タイトルなど外から入る文字は `textContent` で描く。

| 名前 | 内容 |
| --- | --- |
| `graph.ts` | facts とセッションから列・タスク・辺を組む純粋関数と、前後の差分 |
| `github.ts` | 読み取り専用の Transport、条件付きリクエストでの見張り、facts の取り直し |
| `sessions.ts` | 手元のセッション記録の読み取りと見張り |
| `page.html` | 画面（外部を読み込まない1ファイル） |
