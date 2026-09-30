# harness/scripts/dashboard/

エージェントの状態をグラフで見る手元のダッシュボード（`harness/scripts/dashboard.ts`）の部品。読み取りだけで、GitHub には書かない。

## 起動

```sh
node harness/scripts/dashboard.ts [--port 4177] [--interval 30] [--min-remaining 0.3]
```

表示された `http://127.0.0.1:<port>/` をブラウザで開く。`--interval` は GitHub を確かめる間隔（秒。既定 30、5 より短ければ 5）、`--min-remaining` は API の上限の残りの下限（割合。既定 0.3）。認証は `GH_TOKEN` / `GITHUB_TOKEN`、無ければ `gh auth token` のトークン。止めるには Ctrl+C。

## 見えるもの

- **段階の層（列）**：計画なし → plan → plan-critique → 計画ゲート待ち → 人の判断待ち → 実装待ち → implement → judge → fix → sync → Merge 待ち。脇に「依存待ち」「止まる印」。有効な着手宣言（`claim --stage`）があればその段階、無ければ `fleet-status` と同じ判断（`harness/lib/fleet.ts` の `fleetStatus`）で決める。
- **列の強制のされ方**：列の上端の線と見出しの印で、その段階がどう強制されているかを示す。コードで必須（太い実線。Ruleset の必須チェックか App のゲートが止める）・条件つき（実線。指摘や衝突があるときだけ）・手順だけ（点線。skill の文章だけで、飛ばしても止まらない）・人（二重線）。見出しの「終了条件」を開くと、終了条件と、飛ばしたときに何が止めるかが読める。
- **注意**：批評の記録に気を付けるカードに出す。計画ゲートの記録の計画に `critique` が無い（「批評なし」。批評の関所を計画ゲートに足す前の古い記録。今は `critique` の無い計画は計画ゲートが止める）、`revise` で必須の指摘を残して人が進めると決めた（件数つき）、`critique` の形が崩れている（「批評の記録が読めない」）。
- **状態（カードの左の色）**：着手中・停滞（手動の着手宣言が `humanClaimStaleHours` を超えた）・人待ち・止まっている（hold・blocked・waiting・依存）・衝突（main と衝突）・待機。
- **カード**：Issue と、それに紐付く PR（`Closes #`・Stacked PR の層の `Refs #`）は1枚のカードにまとめ、PR はカードの中の行（番号・状態・着手宣言の段階）で出す。PR に着手宣言の段階があればカードはその段階の列に、状態は Issue と PR の強いほう。Issue の無い PR だけ単独のカード。
- **タスクの層（辺）**：依存（Issue Dependencies）、Epic → 子 Issue、Stacked PR（base が別の開いた PR の head。PR が入ったカードどうしをつなぐ）、タスク → セッション（着手宣言の `session`、または手元のセッションのブランチ）。凡例のチェックで辺の種類ごとに隠せる。
- **カードのセッション**：「N セッション」の折りたたみ。閉じていても、動いているセッションかサブエージェントがあれば点滅する。開くとセッションごとの行とサブエージェント。
- **人がすること**：画面の一番上の一覧。Human Merge の PR、計画ゲートで止まった Issue、止まる印（hold・blocked・waiting）の Issue、`priority:*` の無い Issue（label-audit と同じく `agent:*` か `epic` の付いたものだけ）。自動 Merge 待ちは出さない。
- **手元のセッション**：`~/.claude/projects/` のうち、このリポジトリと worktree（`<親>/<名前>.worktrees/`）のセッション記録。最後に動いた時刻と、サブエージェント（plan-critic・reviewer など）の種類と最後に動いた時刻。90 秒以内に動いていれば点滅する。右の列には動いているセッションだけを出し、残りは「ほか N 件」に畳む。会話の中身は読まない・送らない。

## 更新の仕組み

- GitHub の見張り：`/issues?state=all&sort=updated` を条件付きリクエスト（`If-None-Match`）で `--interval` 秒ごとに問い合わせる。304（変化なし）は API の上限に数えられず、組み直しもしない。
- GitHub の読み直し：`updated_at` が変わった Issue / PR（と、それを Closes する側・される側）だけ facts を取り直す。その材料は、変わった番号をまとめた GraphQL の問い合わせ1回で読む（`github.ts` の `DashboardData` の `refresh`。すべて読み直す `loadAll` も、開いた Issue と開いた PR を1回の問い合わせで読む）。1回で読めないのは次の2つだけ。
  - 接続のページ送り（`pageInfo` の続き）。その接続だけの問い合わせで読み足し、REST には流さない。
  - 新しく開いた PR（紐付けが変わった PR）が、その回に読んでいない Issue に紐付くときの2回目の問い合わせ。
- REST に残るもの：見張りの条件付きリクエスト（上の項）、PR の差分（head ごとに覚え、同じ head では読み直さない）、Stacked PR の層の `/pulls/{n}`（`stack` の欄が GraphQL に無いため。読み直しの回の中だけ、PR ごと（同じ `updated_at`）に1回。`mergeable_state` が main の動きで変わるので、回をまたいでは使わない）。
- App の名義：GraphQL は、読み手から見えない非公開の App（ハーネスの App もそう）の check run の checkSuite の `app` を null で返す。null はハーネスの App（`harness.config.json` の `appSlug`）の名義として読む（見える App は slug のまま）。
- API の上限：応答の `X-RateLimit-*`（資源ごと。`/graphql` は `X-RateLimit-Resource: graphql`）と、GraphQL の応答に `data.rateLimit` があればそれを読む。読み直しのまとめた問い合わせ（ページ送り・2回目の問い合わせも）は `rateLimit` を含み、上限の読み取り（#278、`rate-limit.ts`）はその値も読む。どれかの資源の残りが `--min-remaining` の割合を切ったら、リセットの時刻まで GitHub を読まず、止めていることと再開の時刻を画面の上に出す（読み直しの途中で切ったら、その回の変化は取り込まずに次の回で読み直す）。
- 失敗したとき（403・429・502・503・504・通信の失敗）：決まった間隔では読み直さず、full jitter の exponential backoff（`--interval` を基に倍々、上限 15 分）で遅らせる。`Retry-After`・リセットの時刻より早くしない。成功したら `--interval` に戻る。
- ブラウザの接続（`/events`）が0の間は GitHub を読まない。接続が来たらすぐ1回読む（止めている・遅らせている間はその時刻まで待つ）。
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
| `github.ts` | 読み取り専用の Transport、条件付きリクエストでの見張り、facts の取り直し（まとめた GraphQL の問い合わせでの先読み） |
| `rate-limit.ts` | API の上限の残りを応答から読み、下限を切ったらリセットまで送らない Transport と fetch の包み |
| `scheduler.ts` | 見張りの回し方（間隔・上限で止める・失敗の後の backoff・接続が0の間は読まない） |
| `backoff.ts` | 失敗の後の待ち方（full jitter の exponential backoff） |
| `sessions.ts` | 手元のセッション記録の読み取りと見張り |
| `page.html` | 画面（外部を読み込まない1ファイル） |
