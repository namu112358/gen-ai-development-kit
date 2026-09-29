# harness/templates/

導入先にコピーして使う設定の見本。ここはガードレール（変えると人が Merge する場所）。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `CLAUDE.template.md` | 導入先の CLAUDE.md の雛形で、初回だけ CLAUDE.md として写し、以後は導入先が持つ（`harness/managed.json` の projectOwned）。 | ○ |
| `claude-settings.deny.json` | Claude Code にさせない操作（Merge、main への push、保護ラベルの付け外し、Secret・資格情報の読み出しなど）の一覧。`.claude/settings.json` の `permissions.deny` と同じ内容で、変えるときは両方を直す | ○ |
| `harness.config.json` | 導入先の harness.config.json の雛形（初回だけ写す）。appSlug・projectChecks・guardrailPaths・classification.areas・humanMergePaths を導入先に合わせて書き換える | ○ |
<!-- readme:generated end -->
