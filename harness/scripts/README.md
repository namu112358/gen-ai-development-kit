# harness/scripts/

手元（人や Claude のセッション）で動かすコマンド。`node harness/scripts/<名前>.ts` で実行する。使い方は各ファイルの先頭のコメントにある。

| 名前 | 内容 |
| --- | --- |
| `agent.ts` | セッションが使う CLI。計画・判定コメントの書式の検査と本文の生成（`render-*`）、着手宣言（`claim`）、投稿（`post-plan`・`post-verdict`）、判定の入力（`judge-input`）、fleet の表（`fleet-status`）、worktree の作成など。ガードレール |
| `mutate.ts` | テストが効いているかの確かめ（mutation）。変えた行を少しずつ壊してテストを動かし、落ちなかった箇所を一覧にする。CI の mutation ジョブが使う。結果は情報のためだけ |
| `report.ts` | 判定の集計（Jev に Risk 判定を任せてよいかの判断材料）。`node harness/scripts/report.ts <owner>/<repo> [日数]` |
| `setup.ts` | 導入先のリポジトリの設定（ラベル・Ruleset・Environment・App）を適用する。人がリポジトリ管理者の権限で実行する。ガードレール |
