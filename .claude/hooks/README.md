# .claude/hooks/

Claude Code の hook（セッションの開始や Claude の操作の前に割り込んで動く仕組み）。`.claude/settings.json` で登録している。ここはガードレール（変えると人が Merge する場所）。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `guard.ts` | 付き添いのセッションの PreToolUse hook（.claude/settings.json で Bash と mcp__.* に登録）。 | ○ |
| `session-env.ts` | 付き添いのセッションの SessionStart hook（.claude/settings.json で matcher なしに登録。 | ○ |
<!-- readme:generated end -->
