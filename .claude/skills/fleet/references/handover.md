# fleet の参照用のファイル：ハーネスが更新されたときの交代

fleet の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## ハーネスが更新されたときの交代

Claude Code は担当の定義・CLAUDE.md・skill をセッションの開始時に読むので、始めた後に main でハーネスが変わっても、このセッションは古いまま動く。SessionStart の hook が始めたときの読み込みの版を記録し、`node harness/scripts/agent.ts harness-drift`・`fleet-status`・`claim` がそれを origin と比べる。

1. **見る**：手順1・3と節「待つ間の読み直し」で `fleet-status` を読むたびに、表の下の「このセッションの読み込みは古い」の行を見る（無ければ `node harness/scripts/agent.ts harness-drift` の `stale`）。`claim` も古いと標準エラーに一言出す。
2. **古いとき**：新しい段階・新しい ship を始めない。入れ子の方式では、動いている ship が段階の切れ目で返るのを待つ（ship は「待つ（読み込みが古い）」で返る）。その後、このセッションの着手宣言を `release <番号>` で全部解除し、その後（段階の切れ目）でだけ交代する。段階の途中では交代しない。**judge の段階は、古いセッションでは始めない**（`claim --stage judge` と `step` も止める。止まる理由 `harness-stale`）。
3. **聞かない**：人が直接呼んだ fleet は、交代するかを人に聞かず、2 の切れ目の後すぐ 4（Orca がある）か 5（Orca が無い・動かない）に進む。Orca の worker のときは、節「Orca の worker として動くとき」の 5 のとおり hq に `ask` で「交代しますか」を聞く（hq が人に聞かずに答える。質問の文は印 `[交代]` で始め、Epic 番号（単発は `none`）と `fleet-status` に渡した Issue 番号の集合を入れる。hq が文の言い回しで見分けずに済む）。hq が交代しないと答えた・答えが無い（`答え無し`・時間切れ）ときは、同じ質問を繰り返さず、下の 5 の1行を示して止まる。
4. **Orca があるとき**：Orca の CLI は `node harness/scripts/agent.ts orca-cli` が出す JSON の `command` を使う（`env`・`printenv` で環境変数を読まない。orchestration・orca-cli の skill の案内より優先する。決め方は orca-cli の skill の「Resolve the CLI for this session」と同じ順＝`ORCA_CLI_COMMAND` があればその値、`ORCA_DEV_REPO_ROOT` のある dev checkout なら `orca-dev`、Linux で Orca の端末の外にいるときは `orca-ide`、それ以外は `orca`。Linux の Orca の端末の外では素の `orca` を使わない。GNOME の読み上げソフトが起動しうる）。
   - 本体（`git rev-parse --path-format=absolute --git-common-dir` の親。hq と同じ main の checkout）が既定ブランチで未 commit の変更が無ければ、`git -C <本体> pull --ff-only` で origin に追いつかせる。できなければ起動せず、理由と 5 の1行を示して止まる。
   - orca-cli の skill の端末の起動（`terminal create`。引数は Orca の `skills get` の案内に従う）で、本体で `claude --permission-mode auto "/fleet --epic <Epic番号> <番号…>"` を起動する（番号は `fleet-status` に渡した集合。受け持つ Epic が無ければ `--epic` を付けない）。権限モードは必ず明示する。Epic の fleet なら端末の表示名を `fleet: #<Epic番号> <日本語の短い言葉>` にする（言葉は hq の指示のテーマの名前、無ければ `.agent-harness-workspace` の中身をそのまま使う。hq が無ければ hq の skill の手順4の作り方で Epic のタイトルから作る。表示のためだけで、着手宣言・usage はセッション ID で見分ける）。
   - 起動後に画面のモード表示が `auto mode` かを確かめる。bypass（`bypass permissions`）だった・確かめられないときは、新しいセッションに段階を進めさせずに人に返す。
   - 確かめられたら、引き継ぎの要約（受け持つ Epic、人の判断待ちと待つ理由、進めている Issue・PR）を示して、このセッションは終える（新しい fleet が `fleet-status` を読み直して続きから進め、Epic の終わりまで続ける）。
5. **Orca が無い・動かないとき**：クラウドの付き添いのセッションでは使わない（`check` が `ok: false` になる）。
   - (a) `node harness/scripts/relaunch.ts check` を読む。`ok` が偽なら、`reason` を添えて、止まって人が新しいセッションに渡す1行 `/fleet --epic <Epic番号> <番号…>`（Epic が無ければ `/fleet <番号…>`）と、始め方（本体を `git pull --ff-only` で追いつかせてから `claude --permission-mode auto` で起動し、画面の `auto mode` を確かめる）を示す。
   - (b) `ok` なら `git -C <本体> pull --ff-only` で追いつかせる。できなければ起動せず、理由と (a) の1行を示して止まる。
   - (c) `node harness/scripts/relaunch.ts start --line "<1行>"` を流す。`verified` が真なら、引き継ぎの要約を示して、このセッションは終える。偽なら新しいセッションに1行は渡っていないので、`pane` のウィンドウと1行と始め方を示して人に返す。`started` が偽（`new-window` の失敗）なら `pane` は無いので、`reason` と1行と始め方を示して人に返す。どちらも、もう一度 `start` しない（印で止まる）。
