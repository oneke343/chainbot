# Morpho health-factor monitor

## GraphQL 类型生成

在项目根目录运行 `bun run codegen`，递归扫描 `f/morpho/**/*.gql`，
通过 Morpho GraphQL schema 生成一个 `lib/types.ts`，包含所有查询的结果与变量类型。
`sources/users_positions.ts` 使用其中的 `MorphoUsersPositionsQuery`。
地址、Market ID 和交易哈希映射为 string，BigInt 保留十进制 string；生成过程需要联网。
修改查询后重新运行，生成文件不要手改。Codegen 配置位于根目录 `codegen.ts`。

## HF 告警 WAC

`u/oneke/monitors/morpho_hf_alert` 与 Aave V3 告警使用相同的编排：
`sources/users_positions` 在一次查询中筛选多个用户，按页采集后返回 `user -> positions[]`，
再逐用户调用无状态的 `rules/hf`，将非空 error 消息交给 `u/oneke/channels/notification`，
发送 Telegram 和 FlashDuty，最后返回告警数组。持续低于阈值时每次执行都会告警。

```yaml
users:
  - "0x166Ce42Df5f4BAA94aBC5B62C60dab1B3C73D2a3"
api: "$res:f/morpho/resources/morpho"
defaultThreshold: 1.1
ltvThreshold: 90
thresholds:
  "1:0x完整市场ID": 1.2
```

`thresholds` 按 `chainId:marketId` 精确匹配，未配置市场使用 `defaultThreshold`。
只有 `HF < threshold` 才命中，HF 为 0 保留，等于阈值不命中。
`ltvThreshold` 是百分比，默认 `90`。市场配置的 LLTV 达到或超过阈值时忽略该仓位，
作为类似 eMode 的筛选规则。这里使用市场的清算 LLTV，不是用户实际债务／抵押品比值。
Source 将 `market.lltv` 的 WAD 值除以 `1e16`，在 `lltvPercent` 中返回百分比。
Source 调用独立 GraphQL Script `f/morpho/sources/user_positions`（`sources/user_positions.gql`），使用
`userAddress_in: $users` 和 `chainId_in: null` 查询全部用户、全部网络，
每页最多 1000 条，通过 `skip` 翻页，直到读完 `pageInfo.countTotal`。
按返回的 `user.address` 忽略大小写归组，保留输入地址作为结果 key，没有仓位的用户返回空数组。
翻页提前返回空页或借款仓位缺少 HF 时执行失败。
预览或运行 WAC 前需要部署该查询脚本。
仓位类型位于 `sources/types.ts`，此 WAC 不使用旧 MonitorState。

## 清算与市场风险

`flows/morpho_liquidations__flow` 一次查询最多 1000 条真实 `Liquidation` transaction，使用
`chainId + txHash + logIndex` 去重并保存每链最新 block。首次执行默认只建立基线；分页不完整或
无法和旧游标重叠时拒绝保存状态。

`flows/morpho_market_risk__flow` 按明确的 `market_ids` 查询市场快照。第一版支持：

- `oracle_unusable`、`oracle_price_derivation` 等 API warning；
- 当前 `badDebt`，并保留 API 的 realized/unrealized bad-debt warning；
- `liquidityAssetsUsd`；
- `utilization`。

每个指标都通过 `default_rules` 或 `market_rules` 设置阈值。Source 必须完整返回全部配置市场，
否则 Rule 失败且不覆盖上一份有效状态。
