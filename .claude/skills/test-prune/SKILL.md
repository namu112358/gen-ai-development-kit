---
name: test-prune
description: 人が付き添うセッションで、減らせるテスト（ほかのテストと重なる、文言を固定するだけ、確かめる対象が見えない）を根拠つきで探し、削除・統合・書き直しの案と、直す Issue の下書きを人に示す。「減らせるテストを探して」「テストを整理して」「test-prune の下書きを選ぶ」と頼まれたときに使う。付き添いのセッションの /loop から `--loop` で続けて回せる。
---

# test-prune（減らせるテストの洗い出し）

人が呼んだときか、付き添いのセッションの `/loop` から回すときに、減らせるテストの案を1回分出す手順。決まる集計（カバレッジの重なり・文言の固定・所要時間）は `harness/scripts/test-prune.ts`（ロジックは `harness/lib/test-prune.ts`）が行い、判断の要るもの（本当に減らしてよいか、どの案にするか）はこの手順でセッションが行う。Issue の段階ではないので着手宣言は要らない。テストは自分で消さず、案と Issue の下書きだけを出す。

## 入力

- 対象。既定は全部のテストファイル（`harness/test/**/*.test.ts`。`support/` は除く）。人が絞ったら `--only <glob>`（例 `harness/test/gates-*.test.ts`）で渡す。
- 保守の観測（`node harness/scripts/observe.ts`）の JSON があれば、そのパス。遅いテスト・不安定なテスト・生き残ったミュータントを根拠に添える。無ければ人に聞かず、無いまま進めて報告にそう書く。
- `--loop`：`/loop` から回す回（例 `/loop 7d /test-prune --loop`。patrol からも回る）。`--only` と一緒に使ってよい。手順は「## /loop で回すとき」。`--loop` が無いときは下の手順のまま。

## 集計

1. `node harness/scripts/test-prune.ts [--only <glob>] [--health <observe の JSON>]` を実行する（テストファイルを1本ずつカバレッジ付きで動かすので数分かかる。GitHub にもリポジトリにも書かない）。最後の行が JSON のファイルのパス。
2. そのファイルを読む。数はここから取り、セッションが数え直さない。
   - `files`：テストファイルごとの `tests`（定義の数）・`durationMs`・`exitCode`・`coveredLines`（本体の実行された行）・`uniqueLines`（ほかのどのテストファイルも実行しない行）・`bestOverlap`（行が最も多く含まれる相手と割合）・`pinned`（読むコード以外のファイルと文言を確かめる行の数）・`spawnsChild`・`health`
   - `candidates`：`contained`（`uniqueLines` が 0 で、ほかの1ファイルに行の大半が含まれる）・`pinned`（本体の行を実行せず、ファイルの文言を確かめる）・`no-coverage`（本体の行を実行せず、`pinned` でもない）と、その根拠（`reasons`）
   - `notes`：失敗したテストファイル、読めなかったカバレッジ、`--health` を読めなかった・渡されなかったこと、候補を上限で切った数。報告にそのまま書く
3. 候補は種類の順（`contained` → `pinned` → `no-coverage`）に並べてから `--limit`（既定 30）で切るので、切った数が `notes` にあり、後ろの種類が1件も無ければ、`--limit` を上げて（例 `--limit 200`）実行し直す。

## 判断

`candidates` ごとに、そのテストファイルと重なる先（`overlapWith`）のテストを読み、案を1つ決める。

- 削除：重なる先が同じ振る舞いを同じ強さで確かめている（入力の形・アサーションが同じ）。
- 統合：確かめている入力は違うが、同じ関数を同じ形で呼ぶ（表形式のテストにまとめられる）。
- 書き直し：文言を固定するだけのテスト（`pinned`）を、振る舞いのテストか、保守の観測の docs の照合（`observe.ts` の `docs`）に置き換えられる。docs の照合がすでに同じものを見ているなら、その重複として書く。
- `contained`・`no-coverage` で `spawnsChild` が true のものは、子プロセスに `env` を明示して渡していないか（`NODE_V8_COVERAGE` を受け継がないとカバレッジが欠ける）を本文で確かめる。カバレッジの欠けによる誤りなら「残す」にする。
- 残す：カバレッジが重なっても入力・境界が違う、ほかで確かめていないアサーションがある、生き残ったミュータントの行（`survivedMutantsInOverlap`・`health`）を守っている。決めきれないものは「残す（不明）」にし、推測で削除にしない。
- テストの削除は PR で `agent/tests`（`harness/lib/test-tamper.ts` のテストの改ざんの検査）に検出される前提で、案ごとに「なぜ減らしてよいか」を根拠（テスト名、重なる先、指標の値）で書く。

## 出力

1. 案の一覧を人に示す（文章で。PR・Issue には投稿しない）。案（削除・統合・書き直し・残す）・テストファイル・根拠（重なる先と割合、所要時間、文言を確かめる行、ミュータント・不安定なテスト）と、`notes` の読めなかったもの・打ち切り。
2. 直す Issue の下書きを作る（削除・統合・書き直しの案ごと、または近いものをまとめて）。見出しは Issue Form（[.github/ISSUE_TEMPLATE/agent-task.yml](../../../.github/ISSUE_TEMPLATE/agent-task.yml)）に、タイトルは `harness/lib/title.ts` の書式（Conventional Commits。例 `test(harness): …`）に合わせ、本文に根拠を書く。
3. どの下書きを作るかを AskUserQuestion（複数選択、1回4問まで）で聞く。人が選んだものだけを `gh issue create` で作る。`--label` は渡さない。
4. 作った Issue を plan に進めるかを AskUserQuestion で聞く（おすすめは「作るだけ」）。進めると選ばれたら ship の skill（[.claude/skills/ship/SKILL.md](../ship/SKILL.md)）の手順に従う。

## /loop で回すとき

skill によらない共通の規則（`/loop` の始め方・止め方、回の中で人に聞かないこと）は [docs/operations.md の「見直しを /loop で回す」](../../../docs/operations.md#見直しを-loop-で回す) を参照する。ここには test-prune に固有のことだけを書く。

- 間隔の目安：1日〜2週間おき（例 `/loop 7d /test-prune --loop`）。1回に1分ほどかかる（テストファイルを4本ずつ並行）。[patrol](../patrol/SKILL.md) から回すときは、patrol の決め方（下限 1 日・上限 14 日）が回す時期を決める。
- test-prune は毎回全部のテストを見るので、期間や前回の位置は持たない。回ごとの集計の時刻と下書きを手元の状態のファイル（既定は `git rev-parse --path-format=absolute --git-common-dir` の下の `agent-harness/test-prune-loop.json`。作業ツリーにも GitHub にも書かない）に持つ。
- 1回分の処理（回の中で人の答えを待たない）：
  1. `node harness/scripts/test-prune.ts [--only <glob>] [--health <観測の JSON>]` を実行する。patrol から回すときは、patrol がその回に作った観測の JSON を `--health` に渡す。単独の `/test-prune --loop` では渡さず、無いことを報告に書く。最後の行の JSON を「## 集計」の手順2・3どおり読む。
  2. 「## 判断」の手順を行う。
  3. `node harness/scripts/test-prune-loop.ts pending` で未採用の下書きを読み、同じ案の下書きがすでにあれば新しく作らない（同じ候補が続けて出るため）。
  4. 報告を「## 出力」の手順1どおり文章で出す。報告の先頭に集計の時刻（`generatedAt`）と `headSha` を書く。直す Issue の下書きは3件まで作り、文章で示す。ループの回では AskUserQuestion を呼ばない。`gh issue create` もしない（Issue にするかは、下の「人が選ぶ場面」で人が決める）。
  5. 下書きを JSON の配列（`title`・`body`、同じものがある開いた Issue があれば `duplicateOf`。`labels` は持たせない）で scratchpad に書き、`node harness/scripts/test-prune-loop.ts record <集計の JSON> [--drafts <下書きの JSON>]` で回を記録する。記録するのは報告を出した後だけ。すでに状態にある下書きと同じタイトルのものは記録されず、出力の `duplicates` に出る。
- `record` が集計の JSON の確かめ（形が違う・前回の回の集計より新しくない）で止まったら、人に聞かずにその回を止め、理由を出す（古い JSON を渡した・ほかのセッションが同じ状態で回した恐れ）。状態は変わらない。
- 止め方：`/loop` を止める（止めるよう頼む・セッションを閉じる）。`record` の前に止めた回は記録が残らない（次の回はまた全部のテストを見るので抜けない）。
- 人が選ぶ場面（ループの回の外）：人が「test-prune の下書きを選ぶ」と頼んだら、`node harness/scripts/test-prune-loop.ts pending` で未採用の下書きを読み、どれを作るかを AskUserQuestion（複数選択、1回4問まで）で聞く。人が選んだものだけを `gh issue create` で作り（`--label` は渡さない）、作るたびに `node harness/scripts/test-prune-loop.ts adopt <回の番号> <下書きの番号> <Issue 番号>` で書き戻す。作った Issue を plan に進めるかは「## 出力」の手順4どおり聞く。
- 動作を確かめるときは、`--state <一時のパス>` を `record`・`pending`・`adopt` に渡して、手元の状態のファイルと分ける。

## やってはいけないこと

- テストを自分で削除・書き換えない（案と Issue の下書きだけ。直すのは作った Issue で別に行う）
- ラベルを付けない（`priority:*`・`area:*` は Jev に任せる）
- 人が選んだものだけを作る。人が選ばなかった下書きは作らない
- テストの改ざんの検査（`agent/tests`）や `test:exempt` の扱いを変えない・付けるよう頼まない
- 無人の定期 Routine（schedule・Actions・クラウドの Routine）として動かさない。付き添いのセッションの `/loop` では「## /loop で回すとき」の節どおりに回してよい
- 「テストを自分で削除・書き換えない」「ラベルを付けない」「人が選んだものだけを作る」「報告を判定の材料にしない」は `/loop` の回でも同じ
- Issue 本文を書き換えない
- 報告を判定の材料にしない。reviewer・risk-agent・Jev には渡さない
