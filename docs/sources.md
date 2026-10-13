# データの取り方

日次集計（`scripts/collect-daily.mjs`）が読むものと、その前提。確認日は 2026-10-13。Nevermined の SDK と手順は、実証1の `docs/nevermined.md`（`@nevermined-io/payments` 1.13.0、`@x402/*` 2.28.0）に合わせている。

## 一覧

| 項目 | USDC 直接 | カード払い |
|---|---|---|
| 成約件数 | Solana：JIN の payTo の USDC トークン口座に入金したトランザクション | 前払い：Nevermined の `plan.purchased` イベント（出せなければ Stripe → 手入力の順）。都度払い：実証1ゲートウェイのログで `outcome: ok` のコール |
| 利用回数 | 同上（1件＝1回） | 実証1ゲートウェイのログの `creditsConsumed` の合計 |
| 購入者数 | 支払い元アドレス（USDC が減った口座の owner） | 前払い：`plan.purchased` の `actorUserId`（匿名化）。都度払い：ゲートウェイログの `payerId` |
| 1件あたりの手数料・手数料率 | トランザクション手数料（lamports）× その日の SOL/USD 終値（Binance `SOLUSDC` 日足） | Stripe：買い手の支払額 − 売り手の受取額（Stripe ＋ Nevermined 2%）。出せなければ手入力 |
| 決済1件の所要時間 | 計測用の買い手（`scripts/probe-latency.mjs`） | 同左。加えて、ゲートウェイログの `latencyMs`（外部の買い手） |
| 着金までの日数 | 即時（受取アドレスに直接入る） | Stripe Connect の payout の `arrival_date` − 決済時刻。毎日、直近45日分を確認して書き足す |
| 参考：組織全体の集計 | — | Nevermined analytics の `revenue` / `usage`（自社分を含む。除外はできないので参考値） |

取れなかったものは 0 で埋めず、`sources` に `not_configured` / `error: …` を残す。週次レポートでは、計測できなかった日がある入口について「0 件とは言い切れない」と書く。

## USDC 直接

- 受取先は `config/site.json` の `usdc.pay_to`（`jin.x402jp.com/.well-known/x402.json` の payTo と同じ）。
- `getTokenAccountsByOwner` で USDC のトークン口座を見つけ、`getSignaturesForAddress` で JST の1日分の署名を集め、`getTransaction`（jsonParsed）で payTo の残高が増えたものだけを数える。金額で series（10000）と movers（20000）に分ける。
- **カード払いの裏側の購入もここに出る。** 実証1のゲートウェイは、カード払いの客の代わりに JIN を x402 で買う。そのため、ゲートウェイのウォレットを `config/exclusions.json` に書く。ウォレットが未記入でも、ゲートウェイログの `upstreamTx` と一致するトランザクションは自社分として除外する。
- JIN の 402 では `extra.feePayer`（`CjNF…eKww`）がチェーン手数料を払っている。買い手も売り手も負担していない手数料だが、「この入口の1件あたりのコスト」として数える。誰が払ったかは件数で併記する。

## カード払い

### Nevermined（Events & Analytics）

- `GET /organizations/{orgId}/activity?eventType=plan.purchased&from=&to=`：購入1件ごとのイベント。`actorUserId` を `ANON_SALT` で HMAC 匿名化して保存する。`subject.id` が `config/site.json` の `card.nvm_plan_id` のものだけ数える。
- `GET /organizations/{orgId}/analytics/revenue`、`/usage`：プラン単位の売上・取引数・消費クレジット・利用者数。自社分を分けられないので参考値。
- **組織が Premium 以上でないと 403**（`BCK.ORGANIZATIONS.0022`）。その場合は `nevermined_events: error: …` になり、成約は Stripe → 手入力の順で数える。
- `orgId` は `GET /protocol/plans` の各要素の `.orgId` で分かる。形が崩れた ID だと 200 で全ゼロが返るので、`org-` で始まる形でなければ呼ばない。
- 参考: <https://nevermined.ai/docs/agents-guide/check-revenue.md>、<https://nevermined.ai/docs/api-reference/organizations--activity/list-organization-activity-events.md>

### Stripe Connect

- 売り手は Nevermined のオンボーディングで自分の Stripe アカウントを Connect でつなぐ。そのアカウントの **制限付きキー**（読み取り専用：Balance transactions・Payouts）を `STRIPE_API_KEY` に入れる。
- 直接課金は `type=charge`、destination charge は接続アカウント側で `type=payment` になる。どちらも数える。手数料は `source.amount`（買い手の支払額）− `net`（受取額）。
- 着金日：`GET /payouts?status=paid&arrival_date[gte]=…` と `GET /balance_transactions?payout=po_…` で、取引ごとの着金日を引く。取引 ID は匿名化して突き合わせる。
- 自社の購入：Nevermined の自社の買い手の購入時刻から15分以内の取引（`own_purchase_match_window_sec`）と、`exclusions.card_buyers.stripe_txn_hashes` に書いたもの。
- **未確認**：Nevermined の Connect がどの形（Standard / Express、direct / destination charge）か。Express だと売り手の API キーが無いので、`inputs/card-payments.json`（手入力）を使う。

### 手入力（`inputs/card-payments.json`）

Stripe の API が使えないときだけ使う。実証1の `reports/inputs/card-payments.json` と同じ形に、`kind`（plan / per_call）、`payoutDate`、`own` を足した（`inputs/card-payments.example.json`）。

### 実証1ゲートウェイのログ

実証1の `src/log.ts` の `RequestLogEntry` をそのまま読む（1リクエスト1行、UTC の日ごとのファイル）。使う項目は `ts`・`routeId`・`payerId`・`outcome`・`creditsConsumed`・`latencyMs`・`upstreamTx` だけで、`tokenId` やパスは保存しない。`payerId` は実証1の `LOG_SALT` で匿名化済み。

読み方は次のどちらか。

- `GATEWAY_LOG_DIR`：ゲートウェイと同じマシンで集計するとき
- `GATEWAY_LOG_URL`：`{day}` を UTC の日付に置き換えて GET する。**実証1のゲートウェイにはまだこの配信口がない**ので、Bearer 認証付きで `log/{day}.jsonl` を返す口を足してもらうか、ログを定期的にどこかへ置いてもらう必要がある

## 決済1件の所要時間

`scripts/probe-latency.mjs` が、毎日1回、両方の入口を同じ手順で測る。

1. 支払い情報なしで GET → 402（`first_ms`）
2. USDC 直接：402 の提示を検査し（金額・payTo・資産が設定と完全一致のときだけ）、`@x402/svm` で署名する（`sign_ms`）。カード払い：事前に発行したアクセストークンを使う（0）
3. 支払い情報（`PAYMENT-SIGNATURE` / `payment-signature`）を付けて GET → 200（`paid_ms`）

`total_ms` が「リクエストから 200 まで」。結果は `data/latency/YYYY-MM-DD.jsonl` に追記し、その日の日次データに入る。

- 計測用の買い手は自社。Solana ウォレットは新しく作り、少額だけ入れる（1日 $0.01）。アドレスを `usdc_wallets` に、Nevermined の買い手を `card_buyers` に書く。
- カード払いのトークン発行（`getX402AccessToken`）は事前に1回やるので、時間に含めない。実際のエージェントも発行したトークンを使い回す前提（実証1の買い手と同じ）。
- 外部の買い手の所要時間は、USDC 直接（jin.x402jp.com）側のログを見ない（変更しない）ので測れない。カード払いはゲートウェイ内の時間（`latencyMs`。402 の往復と買い手側の処理は含まない）を参考に出す。
