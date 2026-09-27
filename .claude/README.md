# .claude/

Claude Code（このリポジトリで作業する AI）への指示と設定。人が付き添うセッションの手順（skill）、判定や批評を受け持つサブエージェント（Claude が呼び出す専用の役割）、してはいけない操作を止める設定と hook が入っている。

| 名前 | 内容 |
| --- | --- |
| `agents/` | サブエージェントの定義（Reviewer・Risk Agent・plan-critic・test-designer） |
| `hooks/` | 見張りの hook（Claude の操作を実行前に確かめて止める） |
| `routine.md` | 定期 Routine（毎時の Claude のクラウド実行。将来の構想）が従う手順。ガードレール |
| `settings.json` | Claude Code の設定。させない操作の一覧（`permissions.deny`）と、見張りの hook の登録。ガードレール |
| `skills/` | 付き添いのセッションの手順（ship・plan・implement・judge・fix・sync・fleet） |

ここに無いファイル（`.claude/worktrees/` など）は git で管理しない。
