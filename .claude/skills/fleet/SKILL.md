---
name: fleet
description: 人が付き添うセッションで、複数の Issue を選び、ship の各段階を Issue ごとに交互に進めて、全部を人の Merge 待ちか人の判断待ちまで進める。最後に人がすることを1つの一覧にする。「複数の Issue をまとめて進めて」「fleet で進めて」と頼まれたときに使う。
---

# fleet（複数の Issue を並行して進める）

ship（[.claude/skills/ship/SKILL.md](../ship/SKILL.md)）を、1つのセッションの中で複数の Issue について交互に進める手順。各段階の中身は ship と各 skill に従い、ここに写さない。ship の中でサブエージェントを呼ぶので、ship そのものをサブエージェントにして並べない。

## 入力

- 対象：Issue 番号の一覧（任意）。無ければ `agent:ready`・`agent:plan-ok`・`agent:plan-review` の開いた Issue から選ぶ
- 人が1回にさばける数（任意。既定 3）
- 状態の表：`node harness/scripts/agent.ts fleet-status [--max <n>] [<Issue 番号>...]` の出力（Issue・PR ごとの段階、次にやること、選ぶか・待つ理由、触るファイルの重なり、領域の上限）

## 手順

1. `node harness/scripts/agent.ts fleet-status --max <n>`（対象を指定されたら番号も渡す）で表を出し、「選ぶ」の Issue を控える。以降は同じ番号を渡して表を読み直す。選べる Issue が無ければ、待つ理由を添えて人に返す。
   - 「着手宣言あり」で選ばれない Issue が、このセッションか止まった前のセッションの途中のものなら、人に確かめてから `node harness/scripts/agent.ts release <番号>` で解除して読み直す。
2. 「選ぶ」の Issue ごとに、表の「次にやること」の段階を ship と同じ判断（ship の手順2〜6）で1つ進める。
   - plan：plan の skill。批評（plan-critic）は Issue ごとに並行して呼んでよい。
   - implement：implement の skill。worktree は Issue ごとに分ける。test-designer・実装は並行してよい。
   - judge：judge の skill。Reviewer・Risk Agent は Issue ごとに並行して呼んでよい。
   - fix：fix の skill。
   - sync：sync の skill。
   - 「—」（待つ）：計画ゲート・判定の受け付け・App の Merge 経路を待つ。ほかの Issue を先に進める。
3. 段階を1つ進めるたびに、手順1の `node harness/scripts/agent.ts fleet-status` を読み直して、次にやることを決める。セッションの記憶に頼らない（止まっても同じ手順で続きから再開できる）。
   - 計画の後に「触るファイルが重なるため待つ」になった Issue は、実装に進めない（先に選んだほうの Merge の後に読み直す）。
   - 領域の上限や人がさばける数で待つ Issue は、ほかが Merge されるまで進めない。
4. Merge 済みの Issue が出たら、次にやることが sync になった残りの PR に sync の skill をする（判定が引き継がれたかを確かめ、変わっていれば判定し直す）。
5. 「選ぶ」の Issue が全部、人の Merge 待ち（Ready・人の Merge 待ち、自動 Merge 待ち）か人の判断待ち（plan-review、止まる印あり、各 skill の人に返す条件）になるまで、手順2〜4を繰り返す。
6. `node harness/scripts/agent.ts label-audit <Issue番号..> <PR番号..>` で、扱った Issue・PR に必須ラベルの不足や違反が無いかを確かめる（ラベルは付け外ししない）。
7. `node harness/scripts/agent.ts usage` で、このセッションのトークン数と推定料金を読む。
8. 人に**人がすること**の一覧を1つにまとめて出す（Issue・PR ごとに ship の手順9と同じ項目）。
   - Merge：Human Merge の PR（Merge の順番に意味があれば順番も）。自動 Merge なら何もしない（止めたければ `agent:hold`）
   - 例外ラベル：`test:exempt`・`review:exempt` を付けるかの判断と、その理由を書いた場所
   - `node harness/scripts/setup.ts` の実行が要る変更か
   - Merge 後の確かめ（Issue の Validation Requirements、AC のうち Merge 後に確かめるもの）
   - 人の判断待ち：どの Issue の、どの段階の、何を決めてほしいか
   - ラベルの不足・違反（手順6で見つかったもの）
   - 待たせた Issue と理由（重なり・領域の上限・人がさばける数）
   - 費用：進めた本数と、手順7のトークン数・推定料金

## 終わりの状態

- 選んだ Issue が全部、人の Merge 待ちか人の判断待ちになっている（`node harness/scripts/agent.ts fleet-status` の表で確かめた）。
- 人がすることの一覧（トークン数・推定料金を含む）を出した。
- 続けて使わない worktree は `node harness/scripts/agent.ts worktree-remove <ブランチ>` で消した。

## 人に返す条件

- ship の「人に返す条件」に当たった（その Issue は止めて人に返し、ほかの Issue は進める。一覧にまとめて返す）
- 選べる Issue が無い（止まる印・依存・着手宣言・重なり・上限で全部が待つ）
- 領域の上限か人が1回にさばける数に達し、選んだ Issue が全部待つ状態になった
- 操作が deny などで拒否された（別の方法で試さない）
- やってはいけないこと：Merge、auto-merge の設定、Draft の解除、`agent:plan-ok`・`agent:hold`・`agent:auto-merge-stopped` と `*:exempt` のラベルの付け外し
