# Morpho health-factor monitor

`flows/morpho_health__flow` 监控指定地址在 API 支持的不同网络上所有 Morpho Blue 借款仓位。
每个独立借贷市场独立判断，不合并 HF；Vault 存款份额不属于个人借款仓位。

## 参数

```yaml
api: "$res:f/morpho/resources/morpho"
user: "0x166Ce42Df5f4BAA94aBC5B62C60dab1B3C73D2a3"
default_threshold: 1.15
market_thresholds:
  "Ethereum / wstETH-EURCV / LLTV 86%": 1.30
chain_ids: []
```

阈值仅为用法示例。所有借款市场使用 `default_threshold`，有覆盖项的使用各自阈值。
新市场自动发现并使用默认值。空 `chain_ids` 表示所有 API 支持的网络；非空数组限制范围，
不支持的 ID 报错，不静默忽略。

覆盖值的 key 可以直接复制 Rule 的 `fields.positions` 返回的名称：

- `market_name`：`网络 / 抵押资产-借款资产 / LLTV N%`。
- `name`：在上述名称后增加 ` / 完整 Market ID`，精确匹配某个市场，优先级更高。

相同资产与 LLTV 仍可能有不同预言机或利率模型，因此短名称不保证唯一。
如果一个短名称覆盖项匹配多个返回仓位，Rule 明确报错；改用返回的完整 `name`，
不使用不稳定的数组序号或截断 ID 做身份。内部 ID 为 `chainId:marketId`，避免跨链碰撞。
名称区分大小写，未匹配的配置项显示在 `fields.unused_thresholds`（也可能是仓位已关闭）。
推荐长期配置使用精确名称；显示名称来自 API，名称变更后需要调整覆盖项。

阈值必须大于 0。Flow UI 使用 number，直接调用 Rule 也接受普通十进制字符串。
非法覆盖值会报错，不回退默认值。

## 实现

```text
morpho_user_positions.gql（单次查询） → evaluate_morpho_health → MonitorOutput
```

- Source 是 Windmill 原生 GraphQL Script，接收 GraphQL Resource、`user` 和可选的
  `chain_ids`。一次请求同时取得 `chains` 和 `marketPositions(first: 1000, skip: 0)`，
  不再通过 TypeScript 发请求或维护分页循环。
- 使用 `userAddress_in`、`chainId_in`、`borrowShares_gte: "1"` 查询借款仓位，
  不加 `marketListed` 过滤。Flow 将空 `chain_ids` 转成 GraphQL 的 `null`，表示不限网络，
  不把空数组直接交给查询；直接调用 `.gql` 时，省略 `chain_ids` 或传 `null`。
- Rule 首先验证 `pageInfo.skip === 0`、`pageInfo.count === items.length`、
  `pageInfo.countTotal === items.length`。最多支持所选网络合计 1000 个借款仓位，
  恰好 1000 个可以执行；总数超过 1000、缺字段、数量不符或 GraphQL 部分错误都会报错，
  不判断健康、不覆盖历史状态，也不自动翻页。Flow 对失败的 Source 重试两次。
- 字段整理、网络范围与持仓地址校验在现有 Rule 中执行，不新增转换节点。
- HF 直接使用 API `healthFactor`，不通过外部 USD 报价自己计算。协议计算口径由其
  市场预言机、LLTV 和债务决定。HF 为 0 会命中；有债务但 HF 为 null/非法值会失败。
- `HF < 实际阈值` 进入 active，等于阈值不命中。Rule 把协议数据规范化后交给通用仓位
  状态机；首次进入 active 时每个市场产生一条候选消息，持续 active 不重复发送，恢复后
  可以再次触发。最终返回 `{matched, messages, fields}`。
- 消息表格展示市场、HF、实际阈值、默认/覆盖来源、状态。先显示命中市场，再按 HF 升序。
  超长表格展示摘要，全部仓位留在 `fields.positions`；Telegram 不再拼入超长 fields。

现有借贷协议继续共用 Position Risk Engine；Morpho Source 使用原生 GraphQL Script。
Aave V4 要先发现主网再查仓位，因此是三个节点；Morpho 仍是两个。
没有新增注册中心、MonitorInstance 或调度实体。
规则与发送目的地分离。

## 组合与边界

用户创建独立根 Flow：本 Monitor 子 Flow → `matched_output` → Destination。
Trigger、severity 和 destination 在根 Flow 中选择。AlertPolicy 可以返回多条 AlertMessage，
Root Flow 将整个数组传给批量 Destination；仓位状态去重发生在 Rule 中。

Morpho Adapter 还向通用引擎提供 `borrowAssetsUsd`，可配置 `health_factor_drop`、`debt_growth`
和 `liquidation_buffer` 风险规则。趋势状态按分钟保存，最多覆盖 1440 分钟窗口；消息默认最多
20 条，溢出时由 `message_policy` 决定汇总或截断。

Rule 写入 `{ROOT_FLOW_PATH}/__monitor_state`，所以 Aave、Morpho 和不同用户应使用不同根 Flow，
并避免同一实例并发写入。Source 失败或 Rule 数据校验失败时不覆盖历史有效状态。
MonitorState 的 `inputs` 保存原生 GraphQL Source 的原始返回值，Rule 只在内存中整理仓位；
对外的 `fields.positions` 仍提供可读名称、HF、实际阈值和判定结果。

覆盖范围是 API 已索引的借款地址及网络，不会自动发现地址关联的智能钱包，也不是全链扫描。
`observed_at` 为 Rule 检查时间，不能证明索引数据新鲜；接口延迟或未索引的新部署仍可能漏报。

API：<https://api.morpho.org/graphql>；
[Morpho 官方数据获取文档](https://docs.morpho.org/developers/borrow/tutorials/get-data/)。

在 `windmill-impl` 下运行 `npm test`、`npx tsc --noEmit`、`npm run check`。
只读的 Windmill Source 测试命令为
`wmill script preview f/morpho/scripts/sources/morpho_user_positions.gql -d '<JSON 参数>'`。
完整 `wmill flow preview f/morpho/flows/morpho_health -d '<JSON 参数>'` 会写状态，不会部署；
请使用独立测试实例。
