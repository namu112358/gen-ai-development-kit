# .claude/hooks/

Claude Code の hook（Claude が操作する前に割り込んで確かめる仕組み）。`.claude/settings.json` で登録している。ここはガードレール（変えると人が Merge する場所）。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `guard.ts` | 付き添いのセッションの PreToolUse hook（.claude/settings.json で Bash と mcp__.* に登録）。 | ○ |
<!-- readme:generated end -->
