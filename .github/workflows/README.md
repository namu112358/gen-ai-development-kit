# .github/workflows/

GitHub Actions の設定。ここはガードレール（変えると人が Merge する場所）。

| 名前 | 内容 |
| --- | --- |
| `ci.yml` | CI：PR と main への push で型検査とテスト（`npm run check`）を動かす。PR では mutation ジョブ（テストが効いているかの確かめ。情報のためだけ）も動かす |
| `gate.yml` | ゲート：Issue・PR・コメントの出来事と定期実行（3時間ごと）で、専用 GitHub App として `harness/gates/` を動かす。既定ブランチの設定だけが動き、PR のコードは実行しない |
