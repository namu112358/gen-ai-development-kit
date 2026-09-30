---
name: patrol
description: 人が付き添うセッションの /loop から、保守の観測を回して今回まわすべき見直し（arch-review・qa-retro・test-prune）を選んで動かし、下書きを集める。「/loop で見直しを回して」「patrol で見回って」と頼まれたとき、`/loop <間隔> /patrol` の各回で使う。
---

# patrol（見直しのまとめ役）

付き添いのセッションの `/loop` から1つで呼ぶ、見直しのまとめ役。1回分で保守の観測（`harness/scripts/observe.ts`）を回し、観測の差と前回からの経過で今回まわす見直しを決め、選んだものだけを各 skill のループの回の形で動かして、回の要約を出す。patrol は中身の skill（[arch-review](../arch-review/SKILL.md)・[qa-retro](../qa-retro/SKILL.md)・[test-prune](../test-prune/SKILL.md)）を呼ぶだけで、各 skill の手順・記録・状態は書き直さない。Issue の段階ではないので着手宣言は要らない。

`/loop` で回すときの共通の規則（回すのは付き添いのセッションの `/loop` だけ、1回分で完結させ人の答えを待たない、ループの回は Issue を作らずラベルも付けない、止め方、結果を判定の材料にしない）は [docs/operations.md の「見直しを /loop で回す」](../../../docs/operations.md#見直しを-loop-で回す) に従う。ここには patrol に固有のことだけを書く。

## 入力

```
/loop 6h /patrol
```

- 間隔の目安：数時間〜1日おき（例 `/loop 6h /patrol`）。各見直しの間隔は下の決め方で patrol が絞るので、短めにしても回しすぎない。
- `--max <n>`：1回に動かす見直しの上限（既定 2）。`patrol.ts select` に渡す。人に勧めるだけの見直し（test-prune）は枠を使わない。
- `--state <path>`：状態のファイル（`patrol.ts previous`・`select`・`record` に渡す）。確かめるときの一時の状態に使う。既定は `git rev-parse --path-format=absolute --git-common-dir` の下の `agent-harness/patrol.json`（worktree をまたいで同じ。作業ツリーにも GitHub にも書かない）。
- `--dry-run`：見直しを動かさず、観測・選択・記録と要約だけを行う（確かめるときに arch-review・qa-retro の本物の記録・状態を進めないため）。記録では `select` の `run` を `--ran` として渡す。`--dry-run` は `--state` と一緒のときだけ受け付け、`--state` が無ければその回を止めて理由を出す（既定の状態に、動かしていない見直しを記録しないため）。

## 手順

1回分の処理。回の中で人の答えを待たない。

1. `node harness/scripts/patrol.ts previous [--state <path>]` で前回の観測の JSON のパスを読む（何も出なければ初回）。状態のファイルが壊れている・`version` が違うと誤りで終わるので、その回は観測も見直しも動かさずに、理由（状態のファイルのパス。人が直すか消せば次の回から初回として回る）を出して終える。状態のファイルは上書きしない。
2. `node harness/scripts/observe.ts [--previous <前回の JSON>]` を実行し、最後の行の JSON のパスを得る（`--run-tests` は付けない。遅いテストの節は読めない扱いになり、差は null になる）。失敗したら、その回は見直しを動かさずに理由を出して終える（状態は変えない）。
3. `node harness/scripts/patrol.ts select <観測の JSON> [--max <n>] [--state <path>]` で今回まわす見直しを決める。出力の JSON は `run`（動かす見直し。動かす順）・`suggest`（人に勧めるだけの見直し）・`skipped`（回さないものと理由）・`reasons`（見直しごとの理由の文）。
4. `run` の順に、各 skill の「/loop で回すとき」の1回分の処理を行う（`--dry-run` なら動かさない）。
   - arch-review：`arch-review --loop` の回（[arch-review の「/loop で回すとき」](../arch-review/SKILL.md)）。観測は arch-review の回が自分で回すので、patrol の観測の JSON は渡さない。
   - qa-retro：`qa-retro --loop` の回（[qa-retro の「/loop で回すとき」](../qa-retro/SKILL.md)）。
   - test-prune は `run` に入らない（`suggest` に入る）。patrol は `test-prune.ts` を動かさない。
   - 1つの見直しが失敗・中断しても、残りの見直しは続ける。失敗したものは次の手順で「回した」に数えない。
5. `node harness/scripts/patrol.ts record <観測の JSON> [--ran <回した見直し>]... [--suggested <勧めた見直し>]... [--state <path>]` で回を記録する（回した見直しの時刻・勧めた見直しの時刻を更新し、観測の JSON を状態の置き場所に写す）。回した見直しが無くても記録する（観測の写しが次の回の `--previous` になる）。`suggest` に入った test-prune は `--suggested test-prune` で渡す。
6. 回の要約を文章で出す（PR・Issue には投稿しない）。
   - 観測の差：節ごとの増えた・消えた件数。差が読めない節はその旨
   - 動かした見直しと、回さなかった見直し（`skipped` と `reasons` の理由）
   - 勧める見直し：`suggest` にあれば「test-prune を回す時期です（理由）。人が `/test-prune` を呼ぶ（観測の JSON のパスを渡せる）」
   - たまった下書きの数：`node harness/scripts/agent.ts arch-review-pending` と `node harness/scripts/qa-retro-loop.ts pending` の未採用の数
   - 「Issue にするなら『arch-review の下書きを選ぶ』『qa-retro の下書きを選ぶ』と頼む」（人が選ぶ場面は各 skill の手順のまま）

- 止め方：`/loop` を止める（止めるよう頼む・セッションを閉じる）。手順5の前に止めた回は、次の回が同じ前回から観測の差を出し、見直しの時刻も進んでいない。
- 同時に2つのセッションで patrol を回さない（状態のファイルは1つ。書き込みは一時ファイルに書いてから名前を変えるので壊れはしないが、回した時刻が後の側で上書きされる）。

## 決め方

`harness/lib/patrol.ts` の `selectReviews`（決まる部分。テストは `harness/test/patrol.test.ts`）。見直しごとの定数は `PATROL_REVIEWS`。

| 見直し | 形 | 見る観測の節 | 下限 | 上限 |
| --- | --- | --- | --- | --- |
| arch-review | 動かす（`run`） | `docs` | 12 時間 | 3 日 |
| qa-retro | 動かす（`run`） | `flakyTests`・`mutants` | 1 日 | 7 日 |
| test-prune | 勧めるだけ（`suggest`） | `slowTests`・`flakyTests`・`mutants` | 1 日 | 14 日 |

- 見直しごとに、上から最初に当たったもの：一度も回していない（勧めていない）→ 選ぶ（`never`）／前回から上限以上 → 選ぶ（`overdue`）／下限未満 → 選ばない（`too-soon`）／対応する節に差がある → 選ぶ（`diff`）／それ以外 → 選ばない（`no-diff`）。
- 経過は、動かす形なら前回回した時刻、勧めるだけの形なら前回勧めた時刻から測る（人が `/test-prune` を呼んだかは patrol から見えない）。
- 読めない節（null）と、前回の観測が無いとき（初回・写しが消えた）は差なしとして数える。
- 動かすものが `--max` を超えたら、`never` → `overdue`（超えた時間の長い順）→ `diff`（差の件数の多い順）で上限までにし、残りは `limit` で次の回に回す。

## 出力

- 回の要約（手順6）。PR・Issue には投稿しない。
- 状態のファイルと観測の写し（手元だけ）。動かした見直しの記録・状態は、各 skill の手順どおりその skill が残す。

## やってはいけないこと

- 無人の回で AskUserQuestion を呼ばない。人の判断が要る状態に当たったら、その見直しを止めて理由を要約に書く
- `gh issue create` をしない（Issue にするのは、人が「〜の下書きを選ぶ」と頼んだときに各 skill の手順で）
- ラベルを付けない（`agent:ready`・`priority:*`・`area:*` も）
- PR・Issue に要約を投稿しない
- 各 skill の記録・状態（arch-review の記録、`qa-retro-loop.json` など）を patrol が書き換えない
- 無人の回で test-prune を動かさない（勧めるだけ）
- schedule（Actions・クラウドの Routine）で動かさない
- 要約を判定の材料にしない（reviewer・risk-agent・review-panel に渡さない）

## 終わりの状態

- 回の要約を出した。状態のファイルに回が1件増えている（手順1・2で止めた回、手順5の前に止めた回は増えない）。
- Issue は作られず、ラベルも付いていない。
