# .claude/

Claude Code（このリポジトリで作業する AI）への指示と設定。人が付き添うセッションの手順（skill）、判定や批評を受け持つサブエージェント（Claude が呼び出す専用の役割）、してはいけない操作を止める設定と hook が入っている。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `agents/` | サブエージェント（Claude が作業の途中で呼び出す、役割と読む範囲を絞った別の Claude）の定義。 | 一部 |
| `hooks/` | Claude Code の hook（セッションの開始や Claude の操作の前に割り込んで動く仕組み）。 | ○ |
| `routine.md` | 毎時の Routine は、このファイルの手順で1回分の処理を行う（Routine の設定は docs/setup.md）。 | ○ |
| `settings.json` | Claude Code の設定。させない操作の一覧（`permissions.deny`）と、見張りの hook の登録、bypass permissions を使えなくする設定（`permissions.disableBypassPermissionsMode`）、チームで使うプラグインの登録（版を固定）と外部のページの許可。 | ○ |
| `skills/` | 付き添いのセッション（人が見ている Claude の作業）の手順。 | 一部 |
<!-- readme:generated end -->

ここに無いファイル（`.claude/worktrees/` など）は git で管理しない。
