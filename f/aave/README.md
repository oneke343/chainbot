# Aave monitors

V3 保留 `flows/aave_health__flow`，不改变已有配置和行为。
V4 使用 `flows/aave_v4_health__flow`，按用户在每个 Spoke 的整体账户监控 HF。

## V4 参数

```yaml
api: "$res:f/aave/resources/aave_v4"
user: "0x166Ce42Df5f4BAA94aBC5B62C60dab1B3C73D2a3"
default_threshold: 1.15
market_thresholds:
  "Ethereum / Main": 1.20
  "Ethereum / Bluechip": 1.10
  "Avalanche / AVAX Correlated": 1.05
chain_ids: []
```

阈值只是示例，不代表各市场的安全阈值。所有借款仓位都参与监控，未配置市场覆盖值时使用
`default_threshold`；新开仓自动纳入。`chain_ids: []` 自动查询 API 支持的所有主网，
填写非空数组则只查这些网络；不支持的网络 ID 会报错。

覆盖值按名称匹配，优先级为：

1. `fields.positions[].name`：`网络 / Spoke 名称 / 完整 Spoke 地址`，精确匹配。
2. `fields.positions[].market_name`：`网络 / Spoke 名称`，易读的短名称。
3. `default_threshold`。

可以从 Rule 输出的 `fields.positions` 复制 `name` 或 `market_name`。短名称同时匹配多个返回仓位时
拒绝执行，改用精确名称；内部身份始终是 `chainId:spokeAddress`。名称区分大小写。
未匹配任何返回仓位的覆盖项放在 `fields.unused_thresholds` 中，便于发现拼写错误；
它也可能只是当前没借款的市场，因此不因此让整个监控失败。
阈值必须大于 0；Flow UI 使用 number，直接调用 Rule 也接受普通十进制字符串。

## 三个节点

```text
aave_v4_chains.gql → aave_v4_user_positions.gql → evaluate_aave_v4_health → MonitorOutput
```

- 两个 Source 都是 Windmill 原生 GraphQL Script，不再通过 TypeScript 发请求。
  第一个用 `chains(MAINNET_ONLY)` 发现主网，第二个请求 `userPositions`。
  Aave V4 要求至少一个 chain ID，空数组和 null 都会被接口拒绝；因此不能像 Morpho
  一样用单次无网络限制查询。Flow 把自动发现的网络 ID（或用户指定的非空列表）传给第二步，
  不写死支持的网络。
- 当前 `userPositions` 直接返回列表，没有分页参数，不需要 Morpho 的 `first: 1000`
  或分页数量检查。HF 取 `healthFactor.current`，不自行重算协议风险公式。
- Rule 使用市场实际生效阈值判断 `HF < threshold`，任何仓位命中则 `matched = true`。
  等于阈值不命中，HF 为 0 会命中。比较保留 API 十进制精度，消息显示才舍入。
- HF 为 null 且 API 债务金额为 0 的仓位视为无借款；非 null HF 即使显示债务舍入为 0 也保留。
  有债务但 HF 为 null、缺字段、非法 HF，以及 GraphQL 部分错误都会失败，不当成健康。
- Rule 通过本目录模板和通用 `renderMessage` 生成描述，调用 `setMonitorState` 保存
  `{inputs, states, outputs}`，只返回 `{matched, message?, fields}`。不需要读历史状态。
- 字段整理、网络与持仓地址校验都放在现有 Rule 内，不新增转换节点。MonitorState 的
  `inputs` 保存两个 GraphQL Source 合并后的原始 `chains` 和 `userPositions`；
  标准化后的仓位和实际生效阈值在输出 `fields.positions` 中。
- 完整仓位、实际阈值、阈值来源、命中列表保存在 `fields`，表格按命中优先、HF 升序排列。
  大量仓位时描述限制长度并注明省略数量，完整数据仍在结果中。

## 用户组合与限制

用户根 Flow 调用这个 Monitor Flow，然后连接 `matched_output` 和需要的 Destination。
Trigger、severity、发送目的地不属于 Monitor 参数。现有 `matched_output` 会在每一次
`matched = true` 时发送一次消息，不自带冷却和去重，也不发送恢复通知。

状态位于 `{ROOT_FLOW_PATH}/__monitor_state`。不同用户、不同协议实例必须使用不同根 Flow，
不要把两个会保存状态的 Monitor 子 Flow 塞入同一根 Flow；避免同一根 Flow 并发写入。

只覆盖 API 已索引的仓位和部署，不等同于全链实时扫描。`observed_at` 是 Rule 检查时间，
不是链上区块时间。目标地址必须是持仓地址，不能由 EOA 自动推断其关联智能钱包。
API 零债务与 null HF 的解释依赖索引器，不是独立链上验算。

API：<https://api.v4.aave.com/graphql>；架构说明：
[Aave Pro User Guide](https://aave.com/blog/aave-pro-user-guide)。

本地检查在 `windmill-impl` 下运行 `npm test`、`npx tsc --noEmit`、`npm run check`。
在 Windmill 中只读测试 Source 可使用
`wmill script preview f/aave/scripts/sources/aave_v4_chains.gql -d '<包含 api 的 JSON>'`，
再运行 `wmill script preview f/aave/scripts/sources/aave_v4_user_positions.gql -d '<包含 api、user、非空 chain_ids 的 JSON>'`。
完整 `wmill flow preview f/aave/flows/aave_v4_health -d '<JSON 参数>'` 会执行状态写入；
这不是部署，但不要用生产实例状态进行试验。
