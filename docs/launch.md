# 販売ページ（buy.jin.x402jp.com）の公開

計測期間は 2026-10-22〜11-18（`config/period.json`）。販売ページは期間中に公開し、公開した日を `config/site.json` の `page.published_on` に入れる。それより前の日は、カード側の外部の利用が構造的に 0 件（週次レポートに注記が出る）。期間は延ばさない。

## 本人への依頼（Vercel・Upstash・DNS・GitHub）

上から順に。1〜4 で販売ページが公開でき、閲覧数の計測も始まる。5 はカード入口を開けるためのもので、実証1が本番（Live）に移るまで待つ。

| # | 項目 | 必要な値・操作 | 入れる場所 | 無いと止まるもの |
|---|---|---|---|---|
| 1 | Vercel のプロジェクト | Vercel で「Add New → Project」から `kato9292929/poc-dual-checkout` を取り込む。設定は既定のまま（`vercel.json` がビルドと出力先を決める）。Production Branch は `main` | Vercel | 販売ページそのもの |
| 2 | Upstash Redis | 同じプロジェクトの Storage（Marketplace）で Upstash Redis を追加し、プロジェクトにつなぐ。環境変数は自動で入る（`KV_REST_API_URL` / `KV_REST_API_TOKEN` の名前でもそのまま読む） | Vercel（Storage） | 閲覧数・「説明を開いた回数」の記録 |
| 3 | `STATS_TOKEN` | `openssl rand -hex 32` で作った値。Vercel の Environment Variables（Production）に入れ、**同じ値**を GitHub Secrets にも入れる。入れたら Vercel で Redeploy | Vercel（環境変数）と GitHub Secrets | 日次集計が閲覧数を読むこと（`page: "not_configured"` のまま） |
| 4 | ドメイン | Vercel のプロジェクト → Settings → Domains に `buy.jin.x402jp.com` を追加。x402jp.com の DNS に、Vercel が表示する CNAME（通常 `buy.jin` → `cname.vercel-dns.com`）を足す | Vercel と DNS | `buy.jin.x402jp.com` での公開 |
| 4b | `STATS_URL` | `https://buy.jin.x402jp.com/api/stats` | GitHub Secrets | 日次集計が閲覧数を読むこと |
| 5 | 本番のカードプラン | 実証1が本番に移ったら（`docs/go-live.md`）、本番のプラン ID を教えてもらう。こちらで `config/site.json` の `card.nvm_plan_id` に入れ、`nvm_environment` を `live` にする。購入 URL（`https://nevermined.app/checkout/plan/<id>`）はそこから作る | 実証2の CC に伝える | カードの「準備中」を外すこと。Sandbox のプランはテストカードしか通らないので、公開ページには出さない |

公開できたら、その日付（JST）を CC に伝える。`page.published_on` に入れて、レポートに記録する。

## Sandbox のプランを公開ページに出さない理由

実証1のプランは今、Nevermined の Sandbox にある。Sandbox の購入ページは Stripe のテストカードしか通らず、実際の請求が起きない。外部の買い手が来ても買えず、買えたように見えても売上にならない。そのため `scripts/build-site.mjs` は `card.nvm_environment` が `live` のときだけ購入ボタンを出す。それまでのカードの欄は「準備中」のままで、USDC の入口と価格表、カードでの呼び方の説明は先に公開できる。

## 本番への移行（実証1、2026-10-28 時点で未定）

- 実証1が本番に移るには、Stripe Checkout で使えるカードの範囲と、日本の Stripe アカウントが本番で受け取れるかの確認が先になる。
- 購入画面で保存済みのカードを選んで払う経路は Sandbox で通らない（カード番号を直接入れる経路と自動補充は通る）。外部の買い手に開くときは直接入力の経路を使う。
- 11/18 までに本番へ移れない場合、カード側の外部の利用は「0（本番未移行のため）」として扱う。週次レポートは `card.nvm_environment` が `live` でない間、この注記を出す。

## カードで買える商品

JIN series（$0.01 = 1 クレジット）だけ。実証1のプランは 1 リクエスト 1 クレジット固定で、2 クレジットの movers はゲートウェイに無い（実証1の `config/pricing.json`）。販売ページの価格表では、movers のカードの欄を「カードでは買えません（USDC のみ）」にしている。カードでの呼び出し先は `https://poc-card-credits.vercel.app/api/jin/series`。
