# harness/docs/

ハーネスの規則の文書。導入先にも配る（`harness/managed.json` の managed）。このリポジトリの導入手順・決定ログ・移行は [../../docs/](../../docs/README.md) にある。

<!-- readme:generated start -->
| 名前 | 内容 | ガードレール |
| --- | --- | --- |
| `formats.md` | Claude（Routine・付き添いのセッション）と App は、コメントに JSON のフェンスを埋め込んで状態を受け渡す。 |  |
| `glossary.md` | ハーネスで使う用語を、Issue が流れる順に並べる。 |  |
| `operations.md` | 運用：Issue の書き方、ラベル、人が関わる場面、止める仕組み、困ったときの対応。 |  |
| `review-panel.md` | 公式の code-review（`anthropics/claude-plugins-official` の code-review プラグイン）の手順を骨組みに、このハーネスの観点（⑥ AC・範囲、⑦ 秘密・データ破壊・退行、⑧ `npm run check`）を足したレビュー。 |  |
| `risk-policy.md` | 自動 Merge は Risk Agent（`.claude/agents/risk-agent.md`）の判定だけで決める。 | ○ |
| `security.md` | 安全設計と、受け入れているリスク。 |  |
<!-- readme:generated end -->
