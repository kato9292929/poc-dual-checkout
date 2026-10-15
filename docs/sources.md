# データの取り方

日次集計（`scripts/collect-daily.mjs`）が読むものと、その前提。Nevermined の SDK と手順は、実証1の `docs/nevermined.md`（`@nevermined-io/payments` 1.13.0、`@x402/*` 2.28.0）に合わせている。

## 日次の区切り

JST の 00:00〜24:00（`config/period.json` の `utc_offset`）。各トランザクションには `time_utc`（UTC の時刻）と `date_jst`（JST の日付）の両方を記録する。日次データの `window_utc` に、その日の UTC での範囲が入る。

## 計測期間と期間外の日

日次ジョブは開始日（`config/period.json` の `start`）の前から動き、同じ `data/` に日次データを積む。区別は次のとおり。

- 日次データの `period_phase` は `no_period`（開始日未設定）/ `pre_period` / `in_period` / `post_period`。
- 週次レポートは、保存値ではなく **今の `period.json` から日ごとに求め直す**。開始日をあとで入れても、それより前の日は期間前として本表から外れる（`--resummarize` を待たない）。
- 本表（外部・未分類・自社）は期間中の日だけを数える。期間外の日は末尾の「期間外の日」に件数だけ参考として出す。
- 価格の固定値との照合（`price_check` の mismatch）は期間中の日だけに当てる。期間前は価格を変えてよい。
- 欠けた日（日次データが無い日）も、期間中の日だけを数える。

## 一覧

| 項目 | USDC 直接 | カード払い |
|---|---|---|
| 成約件数 | Solana：JIN の payTo の USDC トークン口座への入金 | プラン購入件数：主系は `card.purchase_source`（`stripe`＝Stripe の取引数〔既定〕／`nvm_events`＝Nevermined の `plan.purchased` イベント数）。もう一方は照合用 |
| 利用回数 | 同上（1件＝1回） | 実証1ゲートウェイのログ：`outcome: ok` のコール数と `creditsConsumed` の合計 |
| 購入者数 | 支払い元アドレス（USDC が減った口座の owner） | ゲートウェイのログの `tokenId`（実証1で匿名化済み）の数 |
| 1件あたりの手数料・手数料率 | トランザクション手数料（lamports）× その日の SOL/USD 終値（Binance `SOLUSDC` 日足）。**seller が払った分だけ**。facilitator の分は参考値として別の列 | Stripe：買い手の支払額 − 売り手の受取額（Stripe ＋ Nevermined 2%） |
| 決済1件の所要時間 | 計測用の買い手（`scripts/probe-latency.mjs`） | 同左。加えてゲートウェイのログの `latencyMs` |
| 着金までの日数 | 即時 | Stripe Connect の payout の着金日 − 決済時刻 |
| 照合 | — | Nevermined の Events & Analytics（自社分を含む組織全体の値） |

取れなかったものは 0 で埋めず、null のまま `sources` に理由を残す。

| `sources` のキー | 値 |
|---|---|
| `usdc_chain`, `sol_usd`, `page` | `ok` / `not_configured` / `error: …` |
| `gateway_log` | `ok` / `missing`（口が未接続・トークン未設定。欠損）/ `error: …`。`--resummarize` で埋めた日は `gateway_log_backfilled_at` が付く |
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

`own_wallets.json` には公開アドレスだけを書く。秘密鍵・環境変数・`.env` は読まない。

| 自社の支払い元 | アドレス | 出所 |
|---|---|---|
| AA | `7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY`（2026-10-15 確定） | 下の「AA のアドレスの確認」 |
| Seller Probe | 未取得 | 設定ファイルにも、コミット済みのログにも公開アドレスが無い（秘密鍵から実行時に導出）。有料の測定もまだ一度も動いていない（下の「チェーン読み取りの確認」） |
| 実証1のゲートウェイ | 未作成 | 作成時に追加する。それまでもゲートウェイログの `upstreamTx` と一致する支払いは own |

`candidates` は own の候補の注記で、照合には使わない（unclassified のまま、注記だけ付く）。確定したら `solana` に移し、`resolved` に記録する。

### AA のアドレスの確認（2026-10-15）

- `https://aa.x402jp.com/api/runs`（公開）の各 run の結果に、支払いの tx 署名（`txHash`）が出ている。JIN（`/api/jin/movers`）への支払いは 2026-09-26〜10-14 の20件で、毎日 21:00 UTC（06:00 JST）の run と、10/14 10:22 UTC の run。
- 20件の tx をすべてチェーンから読み（`getTransaction`）、支払い元（USDC が減った口座の owner）を取った。20件とも `7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY` だった。
- 実証2の集計期間にかかるのは、`irt5N3uK91…`（10/12 JST）、`6154hajSEe…`（10/13）、`4Dj6mCQEV6…`（10/14）、`5xCZSNuRsM…`（10/14）。tx 署名の全文は `own_wallets.json` の `evidence`。
- `/.well-known/agent-card.json`（EIP-8004 の登録情報。Base の agentId 55560）と `/dashboard` には、Solana のアドレスも tx 署名も出ていない。
- 10/14 10:23:08〜10:23:13 UTC の series（$0.01）5件も同じ支払い元だが、AA の `/api/runs` には載っていない（run の記録は movers だけ）。アドレスで判定するので、これも own になる。

## USDC 直接

- `getTokenAccountsByOwner` で payTo の USDC トークン口座を見つけ、`getSignaturesForAddress` で JST の1日分の署名を集め、`getTransaction`（jsonParsed）で payTo の残高が増えたものだけを数える。金額で series（10000）と movers（20000）に分ける。
- tx ごとに、チェーン手数料を誰が払ったか（`fee_payer_role`）を記録する。

  | `fee_payer_role` | 条件 |
  |---|---|
  | `facilitator` | fee payer が `config/site.json` の `usdc.facilitator_fee_payers`（JIN の 402 の `extra.feePayer`、`CjNF…eKww`） |
  | `seller` | fee payer が payTo か `usdc.seller_fee_payers` |
  | `buyer` | fee payer が支払い元（payer） |
  | `other` | どれでもない |

- 売る側の手数料（`seller_fee_usd`・`seller_fee_rate`）には `seller` の分だけを入れる。`facilitator` の分は `facilitator_fee_usd`・`facilitator_fee_rate` として参考値の列に出す。`buyer` の分も参考に出す。

### チェーン読み取りの確認（2026-10-15）

**seller-probe の 10/12 の支払い**：10/12（月曜）は seller-probe の有料測定（`paid-weekly.yml`、月曜 04:41 UTC）の曜日だが、その日に JIN への $0.01 の支払いは無かった。確認した場所は次のとおり（いずれも読み取りのみ）。

- GitHub Actions の実行履歴（`kato9292929/seller-probe` の全 workflow run）：2026-10-15 時点で2回だけ。どちらも `free-probe (daily)`（10/14 08:42 UTC と 10/15 08:16 UTC、いずれも failure）。`paid-probe (weekly)` と `self-check (weekly)` は一度も動いていない。
- コミット済みのログ：`main`・`claude/friendly-volta-rsj0kc` とも `log/`・`self-check/`・`data/` は `.gitkeep` だけ。
- JIN の payTo の入金履歴：JST 10/12〜10/14 の入金は9件で、支払い元はすべて AA（`7PVT…`）。$0.01 の入金は 10/14 の AA の5件だけ。

**取りこぼしの確認**：JST 10/12〜10/14 について、現行の方法（payTo の USDC トークン口座 `DRg7rZXr…jjjy` の署名一覧）と別経路（payTo 本体の署名一覧、トークン口座の失敗 tx を含む全署名）を突き合わせた。

- 入金の tx 9件は、すべて現行の方法で拾えていた。取りこぼしは無い。
- 現行の方法に無かったのは `tscBHt2Ff5…`（10/14 08:10 UTC）の1件だけで、これは payTo **から** `Fs2zgBUo…` への 1 USDC の出金（fee payer はファシリテーター）。入金ではないので、集計に入らないのが正しい。
- payTo の USDC トークン口座は1つだけ（`getTokenAccountsByOwner`）。

## カード払い

### 実証1ゲートウェイのログ

- 実証1の `src/log.ts` の `RequestLogEntry`（1リクエスト1行、UTC の日ごとのファイル）を、実証1ゲートウェイの口 `GET /logs/:date` から読む。URL は `config/site.json` の `card.gateway_base_url` ＋ `card.gateway_log_path`（`/logs/{day}`）。`:date` は UTC の日付として扱う。Bearer は実証1の `LOG_READ_TOKEN`（読み取り専用）。`GATEWAY_LOG_URL` を設定すればそちらを優先する。
- JST の1日は UTC の2日にまたがるので、2ファイルを読んで時刻で絞る。
- 残すのは `ts`・`tokenId`・`routeId`・`outcome`・`creditsConsumed`・`latencyMs`・`upstreamTx` だけ。パスやエラー本文は残さない。
- **2026-10-14 時点で、実証1にはこの口がまだ無い。** それまでの日は `gateway_log: "missing"`（欠損）として記録する。口がつながったら `node scripts/collect-daily.mjs --resummarize <開始日>..<終了日>` を実行すると、欠損の日だけログを取りに行って埋め、数え直す。

### Stripe

- 制限付きの読み取り専用キーを `STRIPE_RESTRICTED_KEY` から読む（権限は Balance transactions・Payouts の Read）。
- 直接課金は `type=charge`、destination charge は接続アカウント側で `type=payment` になる。どちらも数える。
- 着金日は `GET /payouts?status=paid` と `GET /balance_transactions?payout=po_…` で取引ごとに引き、毎日、直近45日分を書き足す。
- 取引 ID は `ANON_SALT` で匿名化して保存する。
- キーが未設定の日は、手数料と着金日を null にして `stripe: "missing"` と記録する。
- `data/stripe/YYYY-MM.csv`（手で書き出した CSV）があれば、それも読む。API で取れた取引が優先で、CSV にしか無い取引を足す。CSV に置いてよい列は `data/stripe/README.md` のとおり。購入者を特定できる列があれば読まずにエラーにし、テスト（`test/data.test.js`）も落ちる。

### Nevermined（照合用）

- `GET /organizations/{orgId}/analytics/revenue`・`/usage`、`/activity?eventType=plan.purchased`。集計値は自社分を含む組織全体の値で、日次データの `nvm_reconcile_incl_own` に入る。`plan.purchased` は1件ずつ（userId を匿名化）`detail.card.nvm_purchases` に残し、`card.purchase_source` が `nvm_events` のときはこれがプラン購入件数の主系になる（購入者は `own_wallets.json` / `external_buyers.json` の `nvm_user_hashes` で分類）。
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
