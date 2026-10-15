# Binance Sources and Monitors

## VIP loan positions

`f/binance/sources/vip_loan_positions` fetches all ongoing VIP loan orders from
`GET /sapi/v1/loan/vip/ongoing/orders`. Pass a `c_binance` Resource containing
`url`, `api_key`, and `api_secret`, with optional `loan_coin` and `collateral_coin`
filters. Set `url` to the API base URL, normally `https://api.binance.com`.
Store credentials through Windmill secret variables.

The result contains only `positions`.
Position fields follow Binance's response, with `orderId` serialized as a string
without precision loss. Decimal strings and collateral lists remain unchanged.
Pages are fetched sequentially with a one-second interval. Request and parsing
errors propagate; the Source does not retry, store history, or evaluate alerts.

The root-level `c_binance.resource-type.yaml` defines the credentials schema and is
included in workspace sync. Resource type files live at the repository root
because the CLI uses their paths as workspace-wide type names.

## VIP loan health factor monitor

`f/binance/rules/hf` calculates `HF = liquidationLtv / currentLTV` for each order,
converting Binance's percentage string such as `"91%"` to the ratio `0.91` first.
`HF = 1` corresponds to the order's reported liquidation LTV. The Source retains
the API's `initialLtv`, `marginCallLtv`, `liquidationLtv`, and `collateralValue` fields.

The rule returns one `error` notification containing all orders whose HF is
strictly below `defaultThreshold`, which defaults to `1.2`, or `null` if none
breach. `thresholds` overrides the HF threshold by `collateralAccountId`, so borrow
orders sharing the same collateral account share one configured threshold. Use
the exact `collateralAccountId` string returned by Binance as the key. It follows
the existing Aave/Morpho monitors and alerts on each run while the condition remains true.

`u/oneke/monitors/binance_vip_hf_alert` composes the VIP loan Source, this rule,
and `u/oneke/channels/notification`. Use the
`$res:u/oneke/resources/binance-key` connection. Its schedule runs every five
minutes with HF threshold `1.2`, `Asia/Shanghai`, and no overlapping scheduled runs.
Source, rule, and notification failures fail the workflow.
