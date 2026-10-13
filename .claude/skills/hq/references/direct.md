# hq の参照用のファイル：ship を直接起こす進め方（`--direct`）

hq の skill（[SKILL.md](../SKILL.md)）の参照用のファイル。手順・節の番号は SKILL.md のもの。

## ship を直接起こす進め方（`--direct`）

`--direct <Epic番号>` で指定した Epic（控えの `directEpics`）は、fleet を挟まずに hq が ship を Orca の worker で直接起こす（hq → ship の2層。試しの進め方で、指定が無ければ手順4の fleet のまま）。ship を worker で起こす手順そのもの（宣言 → worktree → アカウントの選び → 端末の作成と auto mode の確かめ → 宣言の解除 → `worker-start`）は [fleet の skill](../../fleet/SKILL.md) の節「Orca の worker で ship を動かすとき」の 3〜5 にあり、ここに写さない。ここには、起こす側が hq であることで違うところだけを書く。着手宣言・計画ゲート・判定・Merge の経路は ship と各 skill のままで、hq は段階を自分で進めない。

1. **いつ**：手順4の後と、見張りが返るたび（`worker_done` を受けたとき・`timeout` の回）。`directEpics` の Epic ごとに、`node harness/scripts/agent.ts fleet-status --json <その Epic の子課題の番号>...` を読む。
2. **起こす条件**：fleet の skill の同じ節の 3 と同じ（「選ぶ」で、次にやることが段階（plan・implement・judge・fix・sync）で、控えの `ships` に settle していない Dispatch が無い Issue。`worker_done` で返った Issue は、次にやることが変わるまで起こし直さない）。違いは1つで、次にやることが `merged`（Merge 済みの見届け）の Issue も起こす（直接の進め方には fleet がいないため。ship は ship の skill の手順1の「Merge 済みで呼び直されたとき」だけを行う）。数は、その Epic の settle していない ship が表の「同時に動かす ship は <n> まで」（`fleet.maxParallelShips`）未満で、かつ手順8の動いている ship の数（`assign` の `running` に控えの `ships` の settle していない数を足したもの）が `hq.maxParallelShips` 未満の間だけ。新しい設定は足さない。
3. **起こし方**：fleet の skill の同じ節の 4 のとおり。ただし `worker-start` には `--run <hq の Run ID>` を付け、表示名は `ship: #<Issue番号> <短い名前>`（短い名前は Issue のタイトルから。fleet の表示名と同じ作り方）にする。受け取った Dispatch を、控えの `ships` に `{ "theme": "#<Issue番号> <短い名前>", "epic": <Epic番号>, "issue": <Issue番号>, "dispatch": "<Dispatch ID>", "session": null, "worktree": "<絶対パス>", "startedAt": "<ISO>", "next": "<起こしたときの次にやること>" }` で書き、`hq-state.ts ledger-save` で置く。起動に失敗した Issue は出し直さず、手順12の一覧に「起動の失敗」として書く。
4. **ship の worker に渡す指示**：fleet の skill の同じ節の 5 の項目のうち「fleet に聞く」を「前置きの `ask` で hq に聞く」に、`worker_done` の送り先を hq に変え、次を足す。
   - 最初に自分のセッション ID（`AGENT_HARNESS_SESSION`）を `send`（件名 `session`）で hq に返す。
   - heartbeat の本文に今の状況を一言（Issue 番号・段階・次にすること・待っているもの）入れる。
   - 人の Merge 待ちになったら `status`（件名 `ready-<PR>`）を送る。
   - ハーネスの読み込みが古いと分かったら（ship の skill の手順1）、段階の切れ目で `release <番号>` して `worker_done` を `--outcome failed`（レポートに「読み込みが古い」）で送る（交代は hq が次の回に新しい worker を起こして行う）。
   - 実装のモデル：ship の skill の節「実装のモデル（fleet から起こされた ship）」に従う、と指示に書く（直接起こされた ship も、`show-plan` の `modelRouting.use` のモデルのサブエージェントにコードを書く部分を任せる。fleet の進め方と振り分けをそろえ、結果を比べられるようにするため。PR 本文の `実装のモデル:` の行もその節のまま）。
5. **受けたもの**：`question`・`escalation`・`status` は手順7のまま（質問にはテーマの名前の代わりに `#<Issue番号> <短い名前>` を添える）。`session` を受けたら、控えの `ships` のその要素に書く。heartbeat は手順7のまま（`hq-watch.ts` が控えの `ships` からテーマを引いて控える）。`worker_done` は、控えの `ships` の Dispatch と同じかを確かめてから `--report-path` のファイルを読み、項目を手順12の一覧にためる。`worker-release` で解放して控えの `ships` から外し、1 に戻る。
6. **止まった ship**：手順10と同じく `worker-list --include-remote --run <hq の Run ID>` の `liveness` が `exited` のときだけ扱う。宣言が残っていれば、手順10と同じく引き継ぐかを AskUserQuestion で1問だけ聞き、引き継ぐなら新しい worker の指示に `--takeover` での出し直しを書く。1時間に2回の上限と `hq-restart` の記録は手順10と同じ（`theme` は `#<Issue番号>`）。
7. **終わり**：Epic が Close し、その Epic の `ships` が空になったら、`directEpics` から外して `ledger-save` で置く。fleet のワークスペースは無いので、手順5の印と手順11の `worktree rm` は無い（Issue の worktree は ship が `merged` の段階で片付ける）。`--direct` の Epic が開いていない・子課題が無いときは `directEpics` に入れず、手順12の一覧に書く。
8. **hq が替わったとき**：手順1の引き継ぎで `run-use` が成功すれば、控えの `ships` をそのまま引き継ぎ、settle していない Dispatch に `hq-back` を送る（fleet と同じ）。`run-use` が失敗して新しい Run を作ったときは、前の Run の直接の ship とは連絡が取れない。控えの `ships` の Issue を手順12の一覧に「前の Run の直接の ship（#番号・段階）：ship のタブで人が答えるか、終わってから次の回に起こし直す」として出し、`ships` から外す（宣言が残っていれば、次の回の起こす条件で「着手宣言あり」になり起こさない。引き継ぎは人が決める）。
9. **控えの置き直し**：3・5・7 で控えを置くときは、今の控えを `hq-state.ts ledger` で読み直してから `ships`・`directEpics` を書き換えて置く（`ledger-save` は `fleets` の印 `handover` しか前の控えから残さないので、`ships` を落とさないため）。
10. **ペイン**：手順6の ①〜③ のペインは控えの `fleets` から読むので、直接の ship は出ない（試しの範囲）。手順12の一覧が、直接の ship の人がすることを載せる。
