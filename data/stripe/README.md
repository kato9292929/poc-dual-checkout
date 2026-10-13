# data/stripe/YYYY-MM.csv

Stripe の API キー（`STRIPE_RESTRICTED_KEY`）を使えない日の分を、ダッシュボードから手で書き出して置く。日次集計が読む。

- 置いてよい列：`id`、`type`（または `reporting_category`）、`created`（UTC）、`amount`（または `gross`）、`fee`、`net`、`currency`、`automatic_payout_effective_at`（着金日、UTC）
- **購入者を特定できる列（メール・名前・顧客 ID・カード・住所・電話・説明文など）は消してから置く。** 残っていると集計はその CSV を読まずにエラーにし、テストも落ちる
- 金額はドル単位（例 `1.00`）
- 取引 ID は読み込み時に匿名化され、日次データには残らない
