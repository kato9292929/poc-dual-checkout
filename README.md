# poc-dual-checkout — 実証2：JIN を USDC の x402 とカード払いの両方で売る（型P）

Japan Inflation Nowcall（JIN）の同じデータ（`series` / `movers`）を、2つの入口で同じ単価で売る。手数料・着金までの時間・購入者の内訳が、入口によってどう違うかを測る。

どちらの入口も、買い手のエージェントには x402 の支払い要求（402）として見える。違うのは決済の通り道。

| 入口 | 中身 | 決済の通り道 |
|---|---|---|
| USDC 直接 | 既存の `jin.x402jp.com`（変更しない） | チェーン上で USDC が直接動く |
| カード払い | 実証1（`poc-card-credits`）のゲートウェイ ＋ Nevermined のカードプラン | Stripe 経由でカード決済 |

Nevermined のプランはカードか暗号資産のどちらか一方しか持てないので、Nevermined にはカードプランだけを置く。本リポジトリが作るのは **販売ページ・ページ計測・所要時間の計測・日次集計・週次レポート** だけ。

## 価格（期間中は変えない）

| データ | USDC 直接 | カード（前払いの例） |
|---|---|---|
| `series` | $0.01 / call | 1 クレジット |
| `movers` | $0.02 / call | 2 クレジット |
| プラン | — | $1 で 100 クレジット（1 クレジット = $0.01） |

カードを前払い（`prepaid`）にするか都度払い（`per_call`）にするかは、実証1の結果を見て `config/site.json` の `card.mode` で決める。`undecided` の間、販売ページのカード入口は「準備中」と表示される。

価格は `config/site.json`、期間開始時の固定値は `config/period.json`。日次集計のたびに、入口どうしの単価と固定値を照合する。食い違えば日次データの `price_check` に `mismatch` を残し、週次レポートの冒頭に警告を出す。

## 構成

| パス | 役割 |
|---|---|
| `site/index.template.html`, `scripts/build-site.mjs` | 販売ページ（`config/site.json` から `public/index.html` を生成） |
| `api/track.js`, `api/stats.js` | ページ計測（Cookie なし）。閲覧数と、各入口の説明を開いた回数を日ごとに数える（Upstash Redis） |
| `scripts/probe-latency.mjs` | 決済1件の所要時間を、両方の入口で同じ手順で測る |
| `scripts/collect-daily.mjs` | 日次集計 → `data/YYYY-MM-DD.json` |
| `scripts/report-weekly.mjs` | 週次レポート → `reports/YYYY-Www.md` |
| `config/exclusions.json` | 自社の買い手（変更履歴: `config/CHANGELOG.md`） |
| `docs/sources.md` | 各数字の出典、計測方法、未確認の点 |

## 集計項目

| 項目 | USDC 直接 | カード払い |
|---|---|---|
| 成約件数 | 支払い件数 | プラン購入件数・都度払い件数 |
| 利用回数 | 支払い件数 | 消費クレジット数 |
| 購入者数 | 支払い元アドレス数 | 購入者数（匿名化した ID） |
| 1件あたりの手数料 | チェーン手数料 | カード手数料（実測） |
| 手数料率 | 売上に対する割合 | 売上に対する割合 |
| 決済1件の所要時間 | リクエストから 200 まで | リクエストから 200 まで |
| 着金までの日数 | 即時 | Stripe Connect の入金日 |

自社（AA、Seller Probe、実証1のゲートウェイ、実証1の検証用買い手、実証2の計測用の買い手）は全集計から除き、週次レポートに参考値として別表で出す。除外は日次データの明細に対して集計のたびに当て直すので、除外リストを直したら過去の日も数え直せる（`--resummarize`）。外部の購入者がいない週は、レポートの冒頭にそう書く。

保存するのは、ウォレットアドレスと匿名化した ID（Nevermined の userId、Stripe の取引 ID、実証1の payerId）だけ。

## 立ち上げ手順

実証1が Sandbox で動いてから始める。

1. **カード入口の形を決める**（実証1の結果を見て）。`config/site.json` の `card.mode`（`prepaid` / `per_call`）、`nvm_plan_id`、`nvm_agent_id`、`plan_purchase_url`、`gateway_base_url`、`stripe_match` を設定する。プランの受取先（`nvm_receiver_address`）は Nevermined の売り手ウォレット `0x6d56…43Ed5` を入れてある。
2. **自社の買い手を書く**：`config/exclusions.json` の `TODO_*` を AA・Seller Probe・実証1ゲートウェイ・計測用の Solana アドレスに置き換える。実証1の検証用買い手と計測用の買い手を `card_buyers` に入れる（`scripts/anon.mjs`、または実証1のログの `payerId`）。`version` を上げて `CHANGELOG.md` に記録する。
3. **実証1のゲートウェイのログを読めるようにする**（`docs/sources.md`）。
4. **販売ページをデプロイ**：Vercel にこのリポジトリをつなぎ、ドメイン `buy.jin.x402jp.com` を割り当てる。Upstash Redis を追加し、`UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` / `STATS_TOKEN` を設定する。
5. **GitHub Secrets を設定**：`.env.example` の集計用と計測用の値。
6. **期間を始める**：`config/period.json` の `P1.start` と `locked.card_mode` を入れてコミットする。4週間は価格とカードの mode を変えない。

以降は GitHub Actions が動く。

- `daily`：毎日 06:13 JST に所要時間を測り、前日分を `data/` にコミットする
- `weekly-report`：毎週月曜 07:07 JST に前週分を `reports/` にコミットする

手で回すときは次のとおり。

```sh
npm ci
npm test
npm run build                                          # public/index.html
node scripts/probe-latency.mjs
node scripts/collect-daily.mjs --date 2026-11-03
node scripts/collect-daily.mjs --resummarize 2026-11-01..2026-11-28
node scripts/report-weekly.mjs --week 2026-W45
```

## 未確認・要確認

- Nevermined の組織が Premium 以上か（Events & Analytics の API に必要）
- Stripe Connect の形（Standard / Express）と、売り手の API キーが使えるか
- 実証1ゲートウェイのログを外から読む口
- 都度払いにする場合のカード1件あたりの課金のされ方（Stripe の最低決済額との関係）

## やらないこと

- `jin.x402jp.com` の x402 実装の変更
- 購入者を特定できる個人情報の保存
- 期間中の価格変更
