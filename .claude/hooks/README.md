# .claude/hooks/

Claude Code の hook（Claude が操作する前に割り込んで確かめる仕組み）。`.claude/settings.json` で登録している。ここはガードレール（変えると人が Merge する場所）。

| 名前 | 内容 |
| --- | --- |
| `guard.ts` | 見張りの hook。Claude が Bash や GitHub の MCP ツールを使う前に中身を読み、main への push・force push・Merge・Draft の解除・保護ラベル（`agent:plan-ok` など）の付け外しを止める |
