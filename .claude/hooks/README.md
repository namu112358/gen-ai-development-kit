# .claude/hooks/

Claude Code の hook（セッションの開始や Claude の操作の前に割り込んで動く仕組み）。`.claude/settings.json` で登録している。PreToolUse の hook は2つで、`guard.ts`（Bash・MCP。push・Merge・保護ラベル）と `workspace-guard.ts`（Edit・Write・NotebookEdit・Bash。main の checkout と fleet のワークスペースの中の書き換え）。`workspace-guard.ts` は `guard.ts` の字句の分け方（`parseScript`）を使うので、`guard.ts` が読み込めないと `workspace-guard` も動けないときの deny になる。`workspace-guard.ts` は Bash のリダイレクト・`sed -i`・`rm` など git 以外の書き換えを止めない（抜け道。[docs/security.md](../../docs/security.md#受け入れているリスク)）。ここはガードレール（変えると人が Merge する場所）。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `guard.ts` | 付き添いのセッションの PreToolUse hook（.claude/settings.json で Bash と mcp__.* に登録）。 | ○ |
| `run.mjs` | hook の入口。 | ○ |
| `session-env.ts` | 付き添いのセッションの SessionStart の hook。 | ○ |
| `workspace-guard.ts` | 書き換えの場所の見張りの PreToolUse hook（.claude/settings.json で Edit・Write・NotebookEdit・Bash に登録）。 | ○ |
<!-- readme:generated end -->
