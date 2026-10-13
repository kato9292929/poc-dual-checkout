# poc-dual-checkout — 実証2：JIN をカード払いと x402 の両方で売る（型P）

Japan Inflation Nowcall（JIN）の同じデータ（`series` / `movers`）を、2つの入口で同じ単価で売る。どちらの入口で、人間とエージェントのどちらが、何件買ったかを測る。

```
                       ┌─▶ カード払い（Nevermined プラン → 実証1のゲートウェイ）
販売ページ ─────────────┤
（buy.jin.x402jp.com）  └─▶ x402（jin.x402jp.com、既存のまま）
```

本リポジトリが作るのは **販売ページ・ページ計測・日次集計・週次レポート** だけ。`jin.x402jp.com` の x402 実装には手を入れない。カードの入口は実証1（`poc-card-credits`）のゲートウェイと Nevermined のプランを使う。

## 価格（期間中は変えない）

| データ | x402 | カード |
|---|---|---|
| `/api/jin/series` | $0.01 / call | 1 クレジット |
| `/api/jin/movers` | $0.02 / call | 2 クレジット |
| プラン | — | $5 で 500 クレジット（1 クレジット = $0.01） |

価格は `config/site.json`。期間の開始時点の価格は `config/period.json` に固定しておき、日次集計のたびに照合する。食い違えば日次データの `price_check` に `mismatch` を残し、週次レポートの冒頭に警告を出す。

## 構成

| パス | 役割 |
|---|---|
| `site/index.template.html`, `scripts/build-site.mjs` | 販売ページ。`config/site.json` から `public/index.html` を生成する |
| `api/track.js` | ページ計測（POST）。Cookie なし。日ごとの閲覧数・ボタン別クリック数を Upstash Redis で数えるだけで、IP アドレスや UA は保存しない |
| `api/stats.js` | 計測値の読み出し（GET、Bearer トークン） |
| `scripts/collect-daily.mjs` | 日次集計 → `data/YYYY-MM-DD.json` |
| `scripts/report-weekly.mjs` | 週次レポート → `reports/YYYY-Www.md` |
| `config/classify.json` | 人間 / エージェントの判定ルールと自社ウォレット（変更履歴: `config/CHANGELOG.md`） |
| `docs/card-source.md` | カード側のデータの取り方と、実証1ゲートウェイの利用ログの形式 |

## 集計の中身

**x402**: JIN の受取アドレス `4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf` の USDC トークン口座の取引を Solana RPC で読み、`payTo` の残高が増えたトランザクションを1件の支払いとして数える。支払い元は、同じトランザクションで USDC が減った口座の owner。金額で series（10000）と movers（20000）に分ける。チェーン手数料は、fee payer がファシリテーター（`CjNF…eKww`）なら 0 として数える。

**カード**: Stripe の charge と、実証1ゲートウェイの利用ログ（`docs/card-source.md`）。

**判定**（`config/classify.json`）

| 入口 | 判定方法 |
|---|---|
| カード払い | プラン購入者は人間。その後の呼び出しは、匿名トークンごとに1日単位で判定する。UA が HTTP ライブラリや LLM エージェントのもの、または高頻度・短間隔なら agent。curl やブラウザなどの手動クライアントで低頻度なら human。それ以外は unknown |
| x402 | 支払い元アドレスごとに、1日の件数と支払い間隔で agent を判定する。それ以外も既定で agent とする（JIN の有料エンドポイントは機械向けで、ブラウザ用のペイウォールがないため） |

自社（AA、Probe、実証1のゲートウェイ）のウォレットとトークンは全集計から除き、週次レポートに参考値として別表で出す。取れなかったソースは 0 で埋めずに `sources` に理由を残す。外部の購入者がいない週は、レポートの冒頭にそう書く。

保存するのはウォレットアドレスと、HMAC で匿名化したトークン ID・Stripe 顧客 ID だけ。メールアドレス・カード情報・IP アドレス・UA は保存しない。

## 立ち上げ手順

実証1のカード入口が動いてから始める。

1. **自社ウォレットを書く**: `config/classify.json` の `own.wallets` の `TODO_*` を、AA・Probe・実証1ゲートウェイの Solana アドレスに置き換える。自社のテスト用トークンと Stripe 顧客のハッシュも入れる（`scripts/anon.mjs`）。`version` を上げて `CHANGELOG.md` に記録する。
2. **カード入口をつなぐ**: `config/site.json` の `card.plan_purchase_url`（Nevermined のプラン購入ページ）、`card.gateway_base_url`、`card.stripe_match` を設定する。未設定のあいだ、販売ページの「カードで購入」は「準備中」と表示される。
3. **販売ページをデプロイ**: Vercel にこのリポジトリをつなぎ（ビルドは `vercel.json` のとおり）、ドメイン `buy.jin.x402jp.com` を割り当てる。Upstash Redis（Vercel Marketplace）を追加し、環境変数 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` / `STATS_TOKEN` を設定する。
4. **GitHub Secrets を設定**: `STATS_URL`（`https://buy.jin.x402jp.com/api/stats`）、`STATS_TOKEN`、`SOLANA_RPC_URL`、`STRIPE_API_KEY`（読み取り専用の制限付きキー）、`GATEWAY_USAGE_URL`、`GATEWAY_USAGE_TOKEN`、`ANON_SALT`。一覧は `.env.example` にある。
5. **期間を始める**: `config/period.json` の `P1.start` に開始日を入れてコミットする。4週間（28日）は `config/site.json` の価格を変えない。

以降は GitHub Actions が動く。

- `daily-collect`: 毎日 06:13 JST に前日分を `data/` にコミットする
- `weekly-report`: 毎週月曜 07:07 JST に前週分を `reports/` にコミットする

手で回すときは次のとおり。

```sh
npm test
npm run build                                   # public/index.html
node scripts/collect-daily.mjs --date 2026-11-03
node scripts/report-weekly.mjs --week 2026-W45
```

## やらないこと

- `jin.x402jp.com` の x402 実装の変更
- 購入者を特定できる個人情報の保存
- 期間中の価格変更
