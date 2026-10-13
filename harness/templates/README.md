# harness/templates/

導入先にコピーして使う設定の見本。ここはガードレール（変えると人が Merge する場所）。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `CLAUDE.template.md` | 導入先の CLAUDE.md の雛形で、初回だけ CLAUDE.md として写し、以後は導入先が持つ（`harness/managed.json` の projectOwned）。 | ○ |
| `claude-settings.deny.json` | Claude Code にさせない操作（Merge、既定ブランチへの push、保護ラベルの付け外し、Secret・資格情報の読み出しなど）の一覧。既定ブランチへの push の3行は `{{defaultBranch}}` の置き場所で、sync が導入先の defaultBranch で埋める。`.claude/settings.json` の `permissions.deny` は、この雛形をこのリポジトリの defaultBranch（main）で埋めたものと同じで、変えるときは両方を直す | ○ |
| `harness.config.json` | 導入先の harness.config.json の雛形（初回だけ写す）。appSlug・projectChecks・project（検証コマンドと取り込みのコマンド）・guardrailPaths・classification.areas・classification.priorityCriteria・humanMergePaths を導入先に合わせて書き換える | ○ |
<!-- readme:generated end -->
