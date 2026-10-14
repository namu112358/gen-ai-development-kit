# review-api

PR レビューの試作の Worker（Cloudflare Workers・Workflows・KV）。設計と手順は [docs/review-api.md](../docs/review-api.md)。

## 構成

詳しい表は docs/review-api.md の節3。

- `src/`：Worker（`worker.ts`）・Workflow（`workflow.ts`）と、Node でも動く純粋なロジック
- `scripts/`：手元の確かめ用（`send-webhook.ts`）と流し直し（`replay.ts`。docs/review-api.md の節11）
- `review.config.json`：モデル・レビューの条件・上限・単価
- `wrangler.jsonc`：Worker・Workflow・KV の束ね方と、秘密でない設定（`vars`。App の識別子・受け付けるリポジトリ・bot の login）。`name`・KV の id・`vars` は導入先ごとの値。秘密は Cloudflare の Secret に入れる
- リポジトリの表 `REVIEW_REPOS`：1つの Worker で複数のリポジトリを受けるときの行ごとの App・installation・Claude のキーの Secret の名前・上限。Cloudflare のダッシュボードの変数に置く（docs/review-api.md の節8.3。無ければ `wrangler.jsonc` の `vars` から1行の表を組む）
- `.dev.vars.example`：`wrangler dev` 用の秘密と、`scripts/send-webhook.ts` が読む installation id の雛形（`.dev.vars` にコピーして使う。commit しない）

## コマンド

```bash
npm install
npm run check                 # 型検査（tsc --noEmit）
npm run dev                   # wrangler dev（http://localhost:8787）
node scripts/send-webhook.ts <action> <owner/repo> <PR 番号> <head>   # 別の端末で署名つきの Webhook を送る（--closes <Issue 番号> などは scripts/send-webhook.ts の先頭を参照）
node scripts/replay.ts <owner/repo> --prs <範囲> --max-usd <USD> --out <ディレクトリ>   # 過去の PR を流し直してローカルの判定と並べる（--list で見込みだけ。docs/review-api.md の節11）
```

Claude を呼ばずに流れだけ見るときは、`.dev.vars` に `DRY_RUN=1` を書く。

## デプロイ・Secret・Workers Builds

docs/review-api.md の節8（セットアップ）と節10（デプロイ）を見る。
