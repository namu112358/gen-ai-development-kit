# harness/scripts/dashboard/

エージェントの状態をグラフで見る手元のダッシュボード（`harness/scripts/dashboard.ts`）の部品。GitHub には書かない（書くのは手元の受け箱だけ）。

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
- **進み**：画面の上の帯（「人がすること」の上）。開いている Epic ごとの「閉じた数／全体」（Epic の子課題 sub-issues の数。`harness/gates/epic-close.ts` と同じ数え方）、今日の Merge の数（手元の日付の 0 時以降。Merge した人が App（`harness.config.json` の `appSlug`）なら App、それ以外は人）、動いているセッションとサブエージェントの数（下の「手元のセッション」の点滅と同じ判断）。数は `graph.ts` の純粋関数 `buildProgress` が組む。Epic と Merge の数は、まだ読んでいない間は「読み込み中」。
- **人がすること**：画面の一番上の一覧。Human Merge の PR、計画ゲートで止まった Issue、止まる印（hold・blocked・waiting）の Issue、`priority:*` の無い Issue（label-audit と同じく `agent:*` か `epic` の付いたものだけ）。自動 Merge 待ちは出さない。
- **気づきを送る欄**：「人がすること」の下。textarea に書いて「送る」と、手元の受け箱に1件入る（4000 文字まで。intel が拾う）。欄の横に、受け箱の未読の数（「intel の受け箱：未読 N 件」）が出る。
- **手元のセッション**：`~/.claude/projects/` のうち、このリポジトリと worktree の置き場所（既定は `<親>/<名前>.worktrees/`。`harness.config.json` の `worktreeRoot` か環境変数 `AGENT_HARNESS_WORKTREE_ROOT` で変えたときはその場所。サーバーの起動時に1回決める）のセッション記録。最後に動いた時刻と、サブエージェント（plan-critic・reviewer など）の種類と最後に動いた時刻。90 秒以内に動いていれば点滅する。右の列には動いているセッションだけを出し、残りは「ほか N 件」に畳む。会話の中身は読まない・送らない。

## 更新の仕組み

- GitHub の見張り：`/issues?state=all&sort=updated` を条件付きリクエスト（`If-None-Match`）で `--interval` 秒ごとに問い合わせる。304（変化なし）は API の上限に数えられず、組み直しもしない。
- GitHub の読み直し：`updated_at` が変わった Issue / PR（と、それを Closes する側・される側）だけ facts を取り直す。その材料は、変わった番号をまとめた GraphQL の問い合わせ1回で読む（`github.ts` の `DashboardData` の `refresh`。すべて読み直す `loadAll` も、開いた Issue と開いた PR を1回の問い合わせで読む）。先読みの仕組み（まとめた問い合わせ・REST の形への変換・`PrefetchTransport`）は `harness/lib/graphql-prefetch.ts` にあり、`agent.ts fleet-status`・`step` も同じものを使う。1回で読めないのは次の2つだけ。
  - 接続のページ送り（`pageInfo` の続き）。その接続だけの問い合わせで読み足し、REST には流さない。
  - 新しく開いた PR（紐付けが変わった PR）が、その回に読んでいない Issue に紐付くときの2回目の問い合わせ。
- 進みの帯の材料：見張りが変化を見つけた回（full・changed）だけ、GraphQL の問い合わせ1回で読む（`github.ts` の `loadProgress`。304 の回は読まない）。開いている Epic は 50 件まで、今日の Merge は前の日からの更新が新しい順の 100 件まで（超えれば「N 件以上」と出す）。失敗は読み直しの失敗と同じ扱い（backoff し、次の回に読み直す）。
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
- 書く入口は `POST /notes` だけ。`Host`・`Origin`（`http://127.0.0.1:<port>` か `http://localhost:<port>` に完全に一致）・起動ごとの合言葉（`x-dashboard-token`。起動のたびに作り、`GET /` で返すページの meta に埋めて配る。ログには出さない）の順で確かめ、合わなければ 403 で何も書かない。続けて `content-type` が `application/json`（違えば 415）、本文は 16 KiB まで（超えれば 413）、`text` は前後の空白を除いて 1〜4000 文字（違えば 400）。書く先はリポジトリの外の受け箱だけで、GitHub・ゲート・ラベルには触れない。

## 受け箱（intel が読む）

- 置き場所：git の共通ディレクトリの下の `agent-harness/inbox/`。`notes/<id>.json` に1件1ファイル（`version`・`id`・`at`・`source`・`text`）、`read/<id>` が読んだ印（空のファイル）。未読は `notes/` にあって `read/` に無いもの。書く側（ダッシュボード）と印を付ける側（intel）が別のファイルを書く。`id` は `<UTC の時刻>-<16進8桁>`で、形に合わない id は読まず・印も付けない。
- `node harness/scripts/dashboard/inbox.ts list`：未読を古い順に JSON の配列（`id`・`at`・`text`）で出す。
- `node harness/scripts/dashboard/inbox.ts mark-read <id>...`：読んだ印を付ける。形の合わない id・無い id があれば何も書かず終了コード 1（合わない id を標準エラーに出す）。
- `node harness/scripts/dashboard/inbox.ts wait [--timeout-ms N]`：未読が1件以上になるまで 2 秒ごとに数え（既定 30 分）、`{"result":"unread","unread":N}` か `{"result":"timeout","unread":0}` を1行出して終了する。intel が見張りとして裏で置く（[intel](../../../.claude/skills/intel/SKILL.md)）。
- ダッシュボードは 5 秒ごとに未読の数を数え直し、変わったときだけ画面に送る（intel が印を付けた分が画面に戻る）。

| 名前 | 内容 |
| --- | --- |
| `graph.ts` | facts とセッションから列・タスク・辺を組む純粋関数と、前後の差分 |
| `github.ts` | 読み取り専用の Transport、条件付きリクエストでの見張り、facts の取り直し（まとめた GraphQL の問い合わせでの先読み） |
| `inbox.ts` | 気づきの受け箱（git の共通ディレクトリの下）の読み書きと、intel が使う CLI（list・mark-read・wait） |
| `rate-limit.ts` | API の上限の残りを応答から読み、下限を切ったらリセットまで送らない Transport と fetch の包み |
| `scheduler.ts` | 見張りの回し方（間隔・上限で止める・失敗の後の backoff・接続が0の間は読まない） |
| `sessions.ts` | 手元のセッション記録の読み取りと見張り |
| `page.html` | 画面（外部を読み込まない1ファイル） |
