# OKX Flexible Loan monitoring

`f/okx/sources/loan_positions` reads
`GET /api/v5/finance/flexible-loan/loan-info`. Omitting the optional `order_id`
returns all existing orders. The Source returns `{ positions }` and preserves
OKX fields, decimal strings, nested collateral assets, and borrowed currencies.
HTTP failures and nonzero OKX response codes fail the job without retries.

`c_okx.resource-type.yaml` defines a required `url`, `api_key`, `api_secret`, and
`passphrase`. All credential fields are required, non-nullable password strings.
Requests use ISO UTC timestamps and Base64 HMAC-SHA256 signatures over
`timestamp + method + requestPath`, including any query string.
Set `url` to the API domain for the account's region. The default is
`https://openapi.okx.com`.

`f/okx/rules/hf` calculates `HF = liqLTV / curLTV`. Both OKX fields are already
ratios. Each `ordId` describes a collateral pool and its borrowed currencies,
so `thresholds` overrides the HF threshold by `ordId`. The default threshold is
`1.2`. The rule returns one `error` notification containing all orders strictly
below their threshold, or `null` when none breach. Alerts repeat on each run
while the condition remains true, following the Binance monitor.

`u/oneke/monitors/okx_loan_hf_alert` composes the Source, rule, and existing
`u/oneke/channels/notification` flow. Its schedule uses `okx-key`, runs every five
minutes at second 49 in `Asia/Shanghai`, and prevents overlapping scheduled runs.
It starts disabled because the new `u/oneke/resources/okx-key` contains blank
credentials. Populate the Resource and enable the schedule before deployment.

API reference: [OKX Flexible Loan](https://www.okx.com/docs-v5/en/#financial-product-flexible-loan-get-loan-info).
Authentication: [OKX REST authentication](https://www.okx.com/docs-v5/en/#overview-rest-authentication).
