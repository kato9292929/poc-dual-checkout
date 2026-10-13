# データの取り方

日次集計（`scripts/collect-daily.mjs`）が読むものと、その前提。Nevermined の SDK と手順は、実証1の `docs/nevermined.md`（`@nevermined-io/payments` 1.13.0、`@x402/*` 2.28.0）に合わせている。

## 日次の区切り

JST の 00:00〜24:00（`config/period.json` の `utc_offset`）。各トランザクションには `time_utc`（UTC の時刻）と `date_jst`（JST の日付）の両方を記録する。日次データの `window_utc` に、その日の UTC での範囲が入る。

## 一覧

| 項目 | USDC 直接 | カード払い |
|---|---|---|
| 成約件数 | Solana：JIN の payTo の USDC トークン口座への入金 | プラン購入件数：Stripe の取引 |
| 利用回数 | 同上（1件＝1回） | 実証1ゲートウェイのログ：`outcome: ok` のコール数と `creditsConsumed` の合計 |
| 購入者数 | 支払い元アドレス（USDC が減った口座の owner） | ゲートウェイのログの `tokenId`（実証1で匿名化済み）の数 |
| 1件あたりの手数料・手数料率 | トランザクション手数料（lamports）× その日の SOL/USD 終値（Binance `SOLUSDC` 日足） | Stripe：買い手の支払額 − 売り手の受取額（Stripe ＋ Nevermined 2%） |
| 決済1件の所要時間 | 計測用の買い手（`scripts/probe-latency.mjs`） | 同左。加えてゲートウェイのログの `latencyMs` |
| 着金までの日数 | 即時 | Stripe Connect の payout の着金日 − 決済時刻 |
| 照合 | — | Nevermined の Events & Analytics（自社分を含む組織全体の値） |

取れなかったものは 0 で埋めず、null のまま `sources` に理由を残す。

| `sources` のキー | 値 |
|---|---|
| `usdc_chain`, `sol_usd`, `gateway_log`, `page` | `ok` / `not_configured` / `error: …` |
| `stripe` | `ok` / `missing`（`STRIPE_RESTRICTED_KEY` 未設定）/ `error: …` |
| `stripe_csv` | `ok` / `not_found` / `error: …`（購入者を特定できる列がある、など） |
| `nvm_api` | `ok` / `unavailable`（403 などで取れない。理由は `nvm_api_reason`）/ `not_configured` |
| `latency_probe` | `ok` / `not_found` |

## 購入者の分類

| 区分 | 条件 |
|---|---|
| own | `config/own_wallets.json` の Solana アドレス・トークン ID・Stripe 取引に一致。または、実証1ゲートウェイのログの `upstreamTx` と一致する USDC の支払い（カード払いの裏側でゲートウェイが JIN を買ったもの） |
| external | `config/external_buyers.json` に一致（外部と確定したもの） |
| unclassified | どちらにも一致しない。自動で external にはしない |

週次レポートは external を本表、unclassified を別表（支払い元アドレス・トークン ID の一覧付き）、own を参考値の表に出す。分類は明細に対して集計のたびに当て直すので、リストを直したら `--resummarize` で過去の日も数え直せる。

`own_wallets.json` には公開アドレスだけを書く。AA と Seller Probe のアドレスは、各リポジトリの設定ファイルには無かった（AA は環境変数 `SOLANA_WALLET_ADDRESS`、Seller Probe は秘密鍵から実行時に導出）。そのため `status: "pending"` のままにしてある。未記入の間、その支払いは unclassified に入る。

## USDC 直接

- `getTokenAccountsByOwner` で payTo の USDC トークン口座を見つけ、`getSignaturesForAddress` で JST の1日分の署名を集め、`getTransaction`（jsonParsed）で payTo の残高が増えたものだけを数える。金額で series（10000）と movers（20000）に分ける。
- JIN の 402 では `extra.feePayer`（`CjNF…eKww`）がチェーン手数料を払っている。買い手も売り手も負担していない手数料だが、「この入口の1件あたりのコスト」として数え、誰が払ったかを件数で併記する。

## カード払い

### 実証1ゲートウェイのログ

- 実証1の `src/log.ts` の `RequestLogEntry`（1リクエスト1行、UTC の日ごとのファイル）を、実証1の外部保存先から読み取り専用のトークンで読む（`GATEWAY_LOG_URL` の `{day}` を UTC の日付に置き換える。`GATEWAY_LOG_TOKEN` を Bearer で付ける）。
- JST の1日は UTC の2日にまたがるので、2ファイルを読んで時刻で絞る。
- 残すのは `ts`・`tokenId`・`routeId`・`outcome`・`creditsConsumed`・`latencyMs`・`upstreamTx` だけ。パスやエラー本文は残さない。
- **2026-10-13 時点で、実証1にはこの外部保存先がまだ無い。**

### Stripe

- 制限付きの読み取り専用キーを `STRIPE_RESTRICTED_KEY` から読む（権限は Balance transactions・Payouts の Read）。
- 直接課金は `type=charge`、destination charge は接続アカウント側で `type=payment` になる。どちらも数える。
- 着金日は `GET /payouts?status=paid` と `GET /balance_transactions?payout=po_…` で取引ごとに引き、毎日、直近45日分を書き足す。
- 取引 ID は `ANON_SALT` で匿名化して保存する。
- キーが未設定の日は、手数料と着金日を null にして `stripe: "missing"` と記録する。
- `data/stripe/YYYY-MM.csv`（手で書き出した CSV）があれば、それも読む。API で取れた取引が優先で、CSV にしか無い取引を足す。CSV に置いてよい列は `data/stripe/README.md` のとおり。購入者を特定できる列があれば読まずにエラーにし、テスト（`test/data.test.js`）も落ちる。

### Nevermined（照合用）

- `GET /organizations/{orgId}/analytics/revenue`・`/usage`、`/activity?eventType=plan.purchased` の件数。自社分を含む組織全体の値で、日次データの `nvm_reconcile_incl_own` に入る。
- 組織が Premium 以上でないと 403。そのときも処理は止めず、その日は `nvm_api: "unavailable"` と記録する。
- 形の崩れた `orgId` だと 200 で全ゼロが返るので、`org-` で始まる形でなければ呼ばない。
- 参考: <https://nevermined.ai/docs/agents-guide/check-revenue.md>

## 決済1件の所要時間

`scripts/probe-latency.mjs` が、毎日1回、両方の入口を同じ手順で測る。

1. 支払い情報なしで GET → 402（`first_ms`）
2. USDC 直接：402 の提示を検査し（金額・payTo・資産が設定と完全一致のときだけ）、`@x402/svm` で署名する（`sign_ms`）。カード払い：事前に発行したアクセストークンを使う（0）
3. 支払い情報（`PAYMENT-SIGNATURE` / `payment-signature`）を付けて GET → 200（`paid_ms`）

`total_ms` が「リクエストから 200 まで」。

- 計測用の買い手は自社。新しく作った Solana ウォレットの公開アドレスと、カード側のトークン ID を `own_wallets.json` に書く。
- カード払いのトークン発行（`getX402AccessToken`）は事前に1回やるので、時間に含めない。
