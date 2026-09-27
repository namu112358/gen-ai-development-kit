# harness/templates/

導入先にコピーして使う設定の見本。ここはガードレール（変えると人が Merge する場所）。

| 名前 | 内容 |
| --- | --- |
| `claude-settings.deny.json` | Claude Code にさせない操作（Merge、main への push、保護ラベルの付け外し、Secret・資格情報の読み出しなど）の一覧。`.claude/settings.json` の `permissions.deny` と同じ内容で、変えるときは両方を直す |
