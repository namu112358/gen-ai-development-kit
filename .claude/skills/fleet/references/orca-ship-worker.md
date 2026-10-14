# fleet の参照用のファイル：Orca の worker で ship を動かすとき

fleet の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## Orca の worker で ship を動かすとき

`fleet.shipMode` が `worker` で、かつ Orca があるときだけ、Issue ごとに ship を Orca の worker（独立した Claude のセッション）で起こす。既定の `subagent` と、Orca が無いときは「手順」「入れ子の方式（orca）」の節で進める。ここに書いていないことは、上の節（入力・選び方・手順）のとおりに進める。hq に起こされた fleet（節「Orca の worker として動くとき」）も、この節で ship を worker で動かしてよい（質問は ship → fleet → hq の順に `ask` で上げる）。

Orca のコマンドは、`node harness/scripts/agent.ts orca-cli` が出す JSON の `command` を実行ファイルとして使う（下では `ORCA` と書く。そのまま打たずに置き換える。決め方は orchestration の skill（[.claude/skills/orchestration/SKILL.md](../../orchestration/SKILL.md)）の「Resolve the CLI for this session」と同じ順で、`harness/lib/worktree.ts` の `orcaCliCommand`。`env`・`printenv` で環境変数を読まない。この点は orchestration・orca-cli の skill の案内より優先する。Linux で Orca の端末の外にいるときは素の `orca` を使わない）。細部は `ORCA skills get orchestration` の、版に合った案内に従う。

1. **Orca の有無を確かめる**：`node harness/scripts/agent.ts fleet-config` の `shipMode` が `worker` のとき、`ORCA status --json` と `ORCA skills get orchestration` を走らせる。両方が成功すれば、この節で進める。どちらかが失敗したら、Orca が無い・動かないとして、今の手順（「手順」と「入れ子の方式（orca）」の節）で進める（戻り先は下の 7）。この分かれ道は、入口の skill（orca-cli・orchestration）の「エラーを報告して止まる」「`ORCA open` で起動する」より優先する。`ORCA open` は試さない。
2. **Run を作る**：`ORCA orchestration run-create --objective "<テーマか Issue 番号の集合>" --json` で fleet の Run を1つ作り、ship の worker の `worker-start`・`check`・`worker-list` には `--run <fleet の Run ID>` を付ける。hq の Run と分かれるので、hq が数える fleet に ship の worker が混ざらない。
3. **worker を起こす条件**：`node harness/scripts/agent.ts fleet-status` の「選ぶ」の Issue のうち、次にやることが段階（plan・implement・judge・fix・sync）で、控え（scratchpad の `fleet-ship-workers.json`：Issue 番号・Dispatch ID・worktree・起こしたときの次にやること・選んだアカウントの `name`・待つ理由と `resetAt`）に settle していない Dispatch が無い Issue のうち、settle していない「素の端末」の行（下の 7）も無い Issue だけを起こす（素の端末の ship が claim するまでは `fleet-status` に着手宣言が出ないので、同じ Issue に2つ目の ship を起こさないため）。素の端末の行は、`fleet-status` の次にやることが人の Merge 待ち・人の判断待ち・Merge 済みになったら settle とみなす（下の 6）。
   - `worker_done`（人の判断待ち・人の Merge 待ち）で返った Issue は、表の次にやることが控えと変わるまで起こし直さない。worker の ship の問いで確認事項を書くのは fleet で、表の次にやることが `resume` の段階に変われば、この起こし直しで再開する。
   - 「—」（計画ゲート・判定の受け付け・Merge 経路を待つ）の Issue は起こさない。
   - 同時に動かすのは、表の「同時に動かす ship は <n> まで」の数まで（`fleet.maxParallelShips`、hq の下なら hq の割り当て）。settle していない素の端末の ship もこの数に数える。
   - アカウントの使用量で `wait` になった Issue（控えに「待つ（アカウントの使用量）」と `resetAt` がある）は、次の読み直し（`worker_done` を受けたとき・`fleet-status` を読み直すとき）と、`resetAt` を過ぎた後の読み直しで、手順4の問い合わせ → 選ぶからやり直す。
4. **worker を起こす**：起こす回（同じ読み直しで起こす Issue の束）の最初に1回だけ `node harness/scripts/accounts/probe.ts` を流して、使用量の控えを新しくする（結果の `skipped`・`failed` では止めず、選ぶに進む。pick が使える控え（問い合わせの控えは 10 分、対応表の設定ディレクトリで書いた控えは 5 分以内）があるアカウントは呼ばない）。そのあと Issue ごとに、次の順で1つずつ進める（並行に流さない）。
   - `node harness/scripts/agent.ts claim <番号> --manual --stage <次にやることの段階>`（次の `worktree` がこのセッションの宣言を要るため。PR の段階なら `node harness/scripts/agent.ts claim <PR番号> --manual --stage judge|fix|sync`）
   - `node harness/scripts/agent.ts worktree claude/issue-<番号>-<短い名前>`（PR があれば、その head のブランチ）
   - `node harness/scripts/accounts/pick.ts` を流し、標準出力の JSON の `result` で分ける（Issue ごとに順に流す。`launches.json` に起こした数が足され、続けて起こす Issue が同じアカウントに偏らない）。
     - `picked`：`terminal send` の文を `<prefix>claude --permission-mode auto` にする（`prefix` は出力の `CLAUDE_CONFIG_DIR='<dir>' ` をそのまま前に付ける）。選んだアカウントの `name` を控えの Issue の行に足す。
     - `default`（対応表が無い・Orca が読めない・候補が無い）、pick が 0 以外で終わった、出力が JSON として読めない：前置き無しの `claude --permission-mode auto` のまま起こす。
     - `wait`：その Issue は起こさず、端末も作らない。`node harness/scripts/agent.ts release <番号>` で宣言を解除し、控えに「待つ（アカウントの使用量）」と `resetAt` を書く。
     - `picked` の後に端末の作成・画面の確かめで失敗して起こさなかったときも、`launches.json` の起こした数は残る（そのアカウントが少しの間選ばれにくくなるだけで、直さない）。
   - `ORCA terminal create --worktree path:<worktree の絶対パス> --json` で素のシェルのターミナルを作り、`ORCA terminal send --terminal <handle> --text "claude --permission-mode auto" --enter` で権限モードを明示して Claude を起動する（`--command` に空白を含めて渡さない決まりのため、`terminal send` で送る）。
   - `ORCA terminal read --terminal <handle> --json` で起動した画面を読み、モードの表示が `auto mode` かを確かめる。bypass（`bypass permissions`）だった・auto でない・確かめられないときは、その worker を起こさず、`ORCA terminal close --terminal <handle>` で閉じ、その Issue を進めずに人に返す（hq に起こされた fleet なら hq に `escalation`）。
   - `node harness/scripts/agent.ts release <番号>`（worker が自分のセッションで宣言し直すため）
   - `ORCA orchestration worker-start --spec "<仕様>" --worktree path:<worktree の絶対パス> --terminal <handle> --run <fleet の Run ID> --json`。受け取った Dispatch ID を控えに書く。
   - `worker-start` には権限モードを渡すフラグが無いので、`--agent claude` で起こさず、権限モードを明示して起動したターミナルを `--terminal` で渡す（起動の画面で `auto mode` を確かめるため）。
5. **仕様**：`--spec` は Task-spec の5項目（対象・すること・守ること・持ち分・終わりの確かめ）で、それだけで分かるように書く。
   - 対象：Issue 番号、worktree の絶対パス、`node harness/scripts/agent.ts fleet-status` に渡す番号の集合と `--max`
   - すること：ship の skill（[.claude/skills/ship/SKILL.md](../../ship/SKILL.md)）で、人の Merge 待ちか人の判断待ちまで進める
   - 守ること：最初に自分のセッションで `node harness/scripts/agent.ts claim <番号> --manual --stage <段階>` を出す。領域の上限で止まったら `--fleet` を付けて宣言し直す（fleet は領域の上限を見ないため）。ほかのセッションの宣言で止まったら何もせず、`worker_done` を `--outcome failed` で送る。人に聞くところは AskUserQuestion を使わず、前置きの `ask` で fleet に聞く。bypass permissions で動いていると分かったら進めず、`--outcome failed` で返す。Merge・Draft の解除・保護ラベルの付け外しをしない
   - 持ち分：その Issue の worktree の中だけを書き換える
   - 終わりの確かめ：人がすることの項目を `--report-path` のファイルに書き、`worker_done` を1回だけ送る。人の判断待ちで止めるなら `node harness/scripts/agent.ts release <番号>` で解除してから送る
6. **待つ・答える**：`ORCA orchestration check --wait --run <fleet の Run ID> --types "worker_done,escalation,question" --json` で待つ。
   - 状態の正は GitHub（`node harness/scripts/agent.ts fleet-status`）で、人の判断の正はラベル。Orca の decision gate は知らせるだけで、判断の正にしない。
   - `question`：fleet が答えられないもの（人の判断）は、今の手順のとおり AskUserQuestion で人に聞く（hq に起こされた fleet なら、節「Orca の worker として動くとき」の 5 のとおり hq に `ask` で上げる）。答えは `ORCA orchestration reply --id <message_id> --body "<人の答え>" --run <fleet の Run ID> --json` で、人の言葉のまま worker に返す。
   - `escalation`：理由を人がすることの一覧に書く（hq に起こされた fleet なら hq に `escalation` で送る）。
   - 素の端末の ship（下の 7）：Run にイベントを出さないので `worker_done` は届かない。`node harness/scripts/agent.ts fleet-status` と Issue・PR の状態で見守り、次にやることが人の Merge 待ち・人の判断待ち・Merge 済みになったら settle とみなして控えを直し、上の 3 の条件で次を起こす。端末は閉じない（タブで人が答えている途中のことがあるため）。Dispatch が無いので `worker-release` は流さない。
   - 素の端末の行がある間の待ち方：控えに settle していない素の端末の行がある間は、hq に起こされたかどうかに関わらず、自分の Run の `check --wait` に `--timeout-ms` を付けて区切る（区切りは節「待つ間の読み直し」の間隔 3 分（`FLEET_WATCH_DEFAULTS`）をミリ秒にしたもの）。区切りごとに `fleet-status` を読み直して素の端末の行の settle を見る。Dispatch の worker が1つも無く、素の端末の行だけが残るときは `check --wait` をせず、節「待つ間の読み直し」の `node harness/scripts/agent.ts fleet-status --watch` で見守る。
   - `worker_done`：`--report-path` のファイルを読み、控えを直し、`node harness/scripts/agent.ts fleet-status` を読み直して、上の 3 の条件で次の worker を起こす。settle した worker は `ORCA orchestration worker-release --dispatch <Dispatch ID> --json` で解放する。
   - 束の中の heartbeat（ship の worker の生存の知らせ）は、読んだらすぐ `--ack <delivery_id>` して、question・escalation・worker_done を後回しにしない（hq の手順7と同じ扱い。heartbeat を ack しないと、その後ろに並んだ question に届かない）。
   - fleet の `release` から worker の `claim` までの間にほかのセッションが宣言したときは、worker が failed の `worker_done` で返る。控えの Dispatch を settle 済みにして解放し、次の読み直しでその Issue が「着手宣言あり」なら起こし直さず、最後の一覧に「#番号 は session … が着手中」と書く（引き継ぐかは人が決める）。
   - hq に起こされた fleet は2つを読む：前置きの `check`（hq からの指示）と、自分の Run の `check --run <fleet の Run ID>`（ship の worker）。段階の切れ目（`worker_done` を受けたとき・`fleet-status` を読み直すとき）には、先に前置きの `check` で hq の指示を読み、次に自分の Run を読む。自分の Run の `check --wait` は `--timeout-ms` を付けて区切り、区切りごとに前置きの `check` と heartbeat をはさむ。
7. **起動に失敗したとき**：`worker-start`（または上の 4 の起動・画面の確かめの手前の Orca のコマンド）が 0 以外で終わった Issue は出し直さず、このセッションで今の手順で進める。
   - hq に起こされていない fleet：入れ子の方式（`fleet.nesting` が `orca`）か、交互の方式（`flat`、または入れ子にできないとき）。
   - hq に起こされた fleet（前置きがあるとき）：入れ子の方式に戻るだけ。入れ子にできなければ、節「Orca の worker として動くとき」の 2 のとおり理由を hq に `escalation` で送って止める（交互の方式では fleet がファイルを書き換えるため）。
   - 入れ子の深さで拒まれたとき（素の端末の方式）：`worker-start` の標準エラー・受け取りの理由に、入れ子の深さ（`depth`・`nest`・`nested`）で拒んだことが出たときは、上の2つに戻らず（hq に起こされた fleet でも、そうでない fleet でも）、素の Orca の端末で ship を起こす。Orca の案内（`ORCA skills get orchestration`）には「nested workers obey the depth limit」とあるだけで、拒んだときの文言は決まっていない。深さで拒まれたかを見分けられないときは、上の2つのとおりに進める。
     - その Issue の上の 4 で作った端末（Claude を起動して待っている）を `ORCA terminal close --terminal <handle>` で閉じる。
     - `ORCA terminal create --worktree path:<worktree の絶対パス> --json` で端末を作り、`ORCA terminal send --terminal <handle> --text "<prefix>claude --permission-mode auto \"/ship <番号>\"" --enter` で ship を起こす。`prefix` は上の 4 でその Issue に流した pick.ts の結果（`picked` の `CLAUDE_CONFIG_DIR='<dir>' `）をそのまま使い、pick.ts を流し直さない（`launches.json` に二重に足さない）。`default` のときは前置き無し。`wait` の Issue は上の 4 で端末を作らないので、ここには来ない。
     - orchestration の Dispatch は作らない（`worker-start` を出し直さない）。
     - 起動の画面を上の 4 と同じく `ORCA terminal read --terminal <handle> --json` で読み、`auto mode` でなければ `ORCA terminal close` で閉じ、その Issue を進めずに人に返す（hq に起こされた fleet なら hq に `escalation`）。
     - 着手宣言は上の 4 で解除したままにする（素の端末の ship が自分のセッションで宣言する）。
     - 素の端末の ship には orchestration の前置きが無いので、人に聞く場面では、そのタブで AskUserQuestion を使って人に直接聞く。質問は fleet・hq に中継されない。
     - 控え（`fleet-ship-workers.json`）のその Issue の行に、Dispatch ID の代わりに「素の端末」と端末の handle・選んだアカウントの `name` を書く。見守り方は上の 6。
     - hq に起こされた fleet は、素の端末で起こしたことと端末の handle（タブ）を hq に `status` で知らせる（人に聞く場面は、そのタブで人が答える）。
   - ship をサブエージェントとして並べる決まり（交互の方式では ship をサブエージェントにしない・入れ子の方式の本数の上限）は残す。Orca の worker は独立したセッションなので、この決まりには当たらない。
8. **人がすることの一覧**：手順9の一覧は、各 worker の `worker_done` のレポートをまとめて作る。worker の ship の費用は、記録のディレクトリが worker ごとに分かれるので `node harness/scripts/agent.ts usage` の合計に入らない。一覧の「費用」にこの限界を書く（worker の費用の合計はこの一覧では出さない）。
   - 動いている worker（控えに settle していない Dispatch）が無く、残りの起こす候補が全部 `wait` のときは、一覧に「アカウントの使用量が全部しきい値以上（一番早いリセット：`resetAt`）」と書いて終える（hq に起こされた fleet は `worker_done` のレポートに書く）。
   - 素の端末で起こした ship は `worker_done` のレポートが無いので、`fleet-status` と Issue・PR の状態から人がすることを書き、タブで人に聞いているもの（人の判断待ち）は端末の handle（タブ）を添える。
