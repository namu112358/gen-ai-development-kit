# harness/scripts/agent/

`harness/scripts/agent.ts` のサブコマンドの実装（`commands/`）と、コマンドが共有する補助（`cli.ts`）。`agent.ts` は入口だけで、`commands/` の直下の `.ts` を名前の順に読み込み、コマンドの名前で振り分ける（Issue #313）。

- `cli.ts`：設定・GitHub・着手宣言・書式の検査・一時ファイルなど、複数のコマンドが使う補助と、コマンドの型（`AgentCommand`）・読み込み（`loadCommands`）
- `commands/`：コマンドのまとまりごとのファイル。各ファイルは先頭のコメントに使い方（`node harness/scripts/agent.ts <コマンド> ...`）を書き、`export const commands: AgentCommand[]` を出す

コマンドを足すときは、`commands/` にファイルを置くか、近いまとまりのファイルに足す。`agent.ts` は変えなくてよい。同じ名前のコマンドが2つあると起動で止まる。`commands/` には `.ts` のコマンドのファイルだけを置く（補助は `cli.ts`、テストは `harness/test/`）。
