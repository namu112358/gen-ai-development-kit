---
name: test-prune
description: 人が付き添うセッションで、減らせるテスト（ほかのテストと重なる、文言を固定するだけ、確かめる対象が見えない）を根拠つきで探し、削除・統合・書き直しの案と、直す Issue の下書きを人に示す。「減らせるテストを探して」「テストを整理して」と頼まれたときに使う。
---

# test-prune（減らせるテストの洗い出し）

人が呼んだときに、減らせるテストの案を1回分だけ出す手順。決まる集計（カバレッジの重なり・文言の固定・所要時間）は `harness/scripts/test-prune.ts`（ロジックは `harness/lib/test-prune.ts`）が行い、判断の要るもの（本当に減らしてよいか、どの案にするか）はこの手順でセッションが行う。Issue の段階ではないので着手宣言は要らない。テストは自分で消さず、案と Issue の下書きだけを出す。

## 入力

- 対象。既定は全部のテストファイル（`harness/test/**/*.test.ts`。`support/` は除く）。人が絞ったら `--only <glob>`（例 `harness/test/gates-*.test.ts`）で渡す。
- 保守の観測（`node harness/scripts/observe.ts`）の JSON があれば、そのパス。遅いテスト・不安定なテスト・生き残ったミュータントを根拠に添える。無ければ人に聞かず、無いまま進めて報告にそう書く。

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

## やってはいけないこと

- テストを自分で削除・書き換えない（案と Issue の下書きだけ。直すのは作った Issue で別に行う）
- ラベルを付けない（`priority:*`・`area:*` は Jev に任せる）
- 人が選んだものだけを作る。人が選ばなかった下書きは作らない
- テストの改ざんの検査（`agent/tests`）や `test:exempt` の扱いを変えない・付けるよう頼まない
- 定期 Routine・schedule として動かさない（`/loop` から呼ぶのは次の段階）
- Issue 本文を書き換えない
- 報告を判定の材料にしない。reviewer・risk-agent・Jev には渡さない
