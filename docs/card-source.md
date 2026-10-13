# カード払い側のデータの取り方

カード側の数字は、次の2つから日次で取り込む。どちらも `scripts/collect-daily.mjs` が読む。

| 項目 | 取り込み元 | 備考 |
|---|---|---|
| 成約件数（プラン購入数） | Stripe `balance_transactions`（type=charge） | `config/site.json` の `card.stripe_match` で JIN プランの charge だけに絞る |
| 購入者数 | 同上の `customer` を HMAC で匿名化して数える | 顧客 ID がない charge は1件＝1人として数える |
| 1件あたりの手数料 | 同上の `fee` | |
| 売上の入金までの日数 | 同上の `available_on − created` | 入金可能になるまでの日数。実際の振込日は payout スケジュールによる |
| 利用回数（消費クレジット数） | 実証1ゲートウェイの利用ログ | 下の形式 |
| 人間 / エージェント | 同上の User-Agent と頻度 | 判定ルールは `config/classify.json` |

## Nevermined について（2026-10-13 時点で確認したこと）

- Nevermined の SDK（`@nevermined-io/payments`）で取れる `getPlanBalance` は、**購入者側**の残りクレジット。売り手側でプランの購入数や消費量を一覧する API は、公式ドキュメントでは見つからなかった。
- 法定通貨のプランは Stripe のチェックアウトで支払われる（`orderFiatPlan` が Stripe のチェックアウト URL を返す）。そのため成約・手数料・入金日は Stripe 側から読む。
- 消費量は、呼び出しを受ける実証1のゲートウェイがクレジットを消費（redeem）した記録から取る。
- 実証1の `docs/nevermined.md` ができたら、上の前提が合っているかを照らし合わせ、違っていればこのファイルと `lib/stripe.js` を直す。

参考: <https://nevermined.ai/docs/development-guide/order-plans>, <https://nevermined.ai/docs/api-reference/typescript/payments-and-balance>

## 実証1ゲートウェイに用意してもらう利用ログの形式

`GET $GATEWAY_USAGE_URL?from=<ISO8601>&to=<ISO8601>`（`Authorization: Bearer $GATEWAY_USAGE_TOKEN`）。
返り値は JSON 配列、`{"calls": [...]}`、JSON Lines のどれでもよい。1行が1回の呼び出し。

```json
{"ts":"2026-11-03T01:23:45Z","token":"<購入者ごとに一意で、個人を特定しないID>","endpoint":"/api/jin/series","credits":1,"status":200,"user_agent":"python-requests/2.32.3"}
```

| フィールド | 必須 | 内容 |
|---|---|---|
| `ts` | ○ | ISO8601 または Unix 秒 |
| `token` | ○ | 購入者（プラン）ごとに一意な ID。メールアドレスなどの個人情報は入れない。本リポジトリ側で `ANON_SALT` を使って HMAC 匿名化してから保存する |
| `endpoint` | ○ | 呼び出したパス |
| `credits` | ○ | 消費したクレジット数（series=1、movers=2） |
| `status` | | HTTP ステータス。400 以上は集計から外す（既定 200） |
| `user_agent` | ○ | リクエストの User-Agent。判定にだけ使い、日次データには保存しない |

IP アドレスは渡さない・保存しない。

## 自社分の除外

自社のテスト用トークンや Stripe 顧客は、匿名化したハッシュを `config/classify.json` の `own.card_token_hashes` / `own.stripe_customer_hashes` に書く。ハッシュは次で出す（生の値はコミットしない）。

```sh
ANON_SALT=... node scripts/anon.mjs <token_or_customer_id>
```
