# Aave monitors

## GraphQL 类型生成

在项目根目录运行 `bun run codegen`，递归扫描 `f/aave/**/*.gql`，按 API 版本生成
`f/aave/v3.types.ts` 和 `f/aave/v4.types.ts`，各自包含该版本所有查询的返回值与变量类型。
修改查询后重新运行，生成文件不要手改。
`aave_v4_` 开头的文件使用 V4 schema，其余文件使用 V3 schema；生成过程需要联网读取 schema。
配置在根目录 `codegen.ts`，地址、金额、时间等自定义 scalar 的 TypeScript 映射也在该文件中。

`sources/aave_v3_users_positions.ts` 使用 `taskScript("./aave_v3_user_positions.gql")`
并行查询用户，返回按用户地址索引的仓位。查询位于
`sources/aave_v3_users_positions__mod/`，类型从 `v3.types.ts` 导入；CLI preview 自动携带查询模块，无需单独部署查询脚本。

V3 保留 `flows/aave_health__flow`，并增加可选 `default_threshold`；未提供时保持只监控显式
`market_thresholds` 的兼容行为，提供后所有借款部署自动使用默认值。
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
- Rule 使用市场实际生效阈值判断 `HF < threshold`。通用仓位状态机只在仓位首次跌破阈值、
  恢复后再次跌破，或者阈值配置变化后仍处于危险状态时产生新的候选消息。
  等于阈值不命中，HF 为 0 会命中。比较保留 API 十进制精度，消息显示才舍入。
- HF 为 null 且 API 债务金额为 0 的仓位视为无借款；非 null HF 即使显示债务舍入为 0 也保留。
  有债务但 HF 为 null、缺字段、非法 HF，以及 GraphQL 部分错误都会失败，不当成健康。
- 协议 Rule 将数据规范化为通用 `HealthInputs`，读取旧 MonitorState，调用通用 HF 状态机，
  再保存 `{inputs, states, outputs}`。每个新触发仓位产生一个候选消息，返回
  `{matched, messages, fields}`。
- Aave V3 Source 同时读取 `totalDebtBase` 和 `totalCollateralBase`，因此也能使用债务增长规则；
  Aave V4 使用 API 的 USD value。趋势规则首次运行只记录基线，达到配置窗口后再判断。
- 字段整理、网络与持仓地址校验都放在现有 Rule 内，不新增转换节点。MonitorState 的
  `inputs` 保存两个 GraphQL Source 合并后的原始 `chains` 和 `userPositions`；
  标准化后的仓位和实际生效阈值在输出 `fields.positions` 中。
- 完整仓位、实际阈值、阈值来源、命中列表保存在 `fields`，表格按命中优先、HF 升序排列。
  大量仓位时描述限制长度并注明省略数量，完整数据仍在结果中。

## 用户组合与限制

用户根 Flow 调用这个 Monitor Flow，然后连接 `matched_output` 和需要的 Destination。
Trigger、severity、发送目的地不属于 Monitor 参数。去重由 Position Rule 的状态机完成；
`matched_output` 可以把本次多个候选消息转换为多个 AlertMessage，Root Flow 将整个数组交给
Destination 批量发送，不再包含 `forloopflow`。

## Position Monitor 扩展边界

Aave V3/V4 都显式实现 `HealthPositionAdapter`。未来其他协议接入时，协议目录只负责：

1. 用原生 GraphQL 或其他 Source 获取用户仓位；
2. 为每个风险账户产生稳定 `position.id`；
3. 转换成通用 `HealthInputs`；
4. 调用通用 HF 状态机并渲染协议名称。

阈值覆盖、HF 下降、债务增长、清算缓冲、统一压力场景、rearm 和消息上限保持在 `chain_sentinel`。

## 第二轮 Flows

- `aave_v3_liquidations` 按 V3 Pool 地址、chain ID 和用户查询最近 50 条真实 liquidation call。
- `aave_v4_liquidations` 一次查询指定网络上某用户最近 50 条 `LIQUIDATED` activity。
- `aave_v3_market_risk` 查询各 reserve 的可用流动性、利用率、Supply/Borrow Cap、冻结和暂停。
- `aave_v4_market_risk` 查询 reserve 的 token supplied/borrowed、Supply/Borrow Cap、可存入/可借数量和操作状态。

### Aave V4 market risk 与 market params changes

`f/aave/flows/aave_v4_market_risk` 负责流动性、利用率、cap 使用率和操作风险阈值。
Cap 使用率通过 `max_supply_cap_used_percent` / `max_borrow_cap_used_percent` 配置，
严格超过阈值才触发；持续命中去重，恢复后再次越线会重新触发。
`spoke_ids` / `reserve_ids` 支持筛选，`market_rules` 支持按 reserve ID 或完整名称覆盖。
Rules 信赖 Aave API 格式，金额使用 BigInt，阈值判断保留整数精度。
零 cap 与无限 cap 不做百分比判断；余额与流动性仍是 API 观测／估算。

**配置变更已经拆出**，market risk 不再保留 cap 基线或发送 cap-change 消息。
配置采集由 `u/oneke/sources/aave_v4_configuration` 调用采集 WAC，
变更监控由 `u/oneke/monitors/aave_v4_configuration_change` 编排。
结果直接采用 Reader 的对象图：`Record<chainId, Record<hubAddress, HubGraph>>`。
`HubGraph` 保留 `hub`、`spokes`、`treasuries`、`tokenizations`、`otherSpokes`、`authorities`，
实体集合保留 Reader 数组，不转换成另一套领域对象，不跨 Hub 合并共享配置。
字段含义、单位和公开接口边界见 [Aave V4 协议配置](MARKET_PARAMS.md)。

采集 Workflow as Code `f/aave/scripts/workflows/collect_aave_v4_market_params`
接收 `api` 与静态 `rpc_urls` 映射。先通过 `taskScript` 调用原生 GraphQL
查询 Hub 地址及 chain ID，再直接遍历 `Object.entries(rpc_urls)`，按网络筛选 Hub，
通过 `Promise.all` 并行调用各网络的 `read_hubs` 子任务。每个网络仍由 multicall 逐个执行 `readHub`。
`read_hubs` 返回 `NetworkParams`（`hub_address → HubGraph`），不接收 chain ID。
Workflow 按对应的 chain ID 聚合各网络结果，直接返回完整快照。
编排入口使用 Bun runtime，以初始化 Workflow as Code 执行上下文。
GraphQL 和网络读取分别是 Windmill 子任务，具备独立日志和 checkpoint；
重放时只重建确定性的聚合对象，已完成的任务结果从 checkpoint 恢复。
没有单独的合并脚本、prepare_networks、pin_block、assembler 或 normalization 脚本。
网络由配置 Source Flow 的静态 RPC 映射指定，不自动发现。

每个网络使用现有 Multicall3 `0xca11bde05977b3631167028862be2a173976ca11`，
在一个 `eth_call` 中调用各 Hub 的 `readHub`；使用 `blockTag=latest`，不额外查询 chain ID 或区块号。
一次 aggregate 内部读取同一区块状态；不同网络分别读取各自的 latest，不固定跨网络区块。
`batchSize=0` 禁止拆批，任一子调用失败即失败。空 Hub 列表返回该网络的空对象，无 RPC 请求。
Reader runtime code 通过 state override 注入固定虚拟地址，不部署、不签名。
不用 creation-based deployless Multicall3：大对象图的返回数据会受到 EIP-170 代码大小限制。
RPC 必须支持 state override，并部署上述 Multicall3；无自动 fallback。

Source 保留 Reader 字段名、数组、零地址、ownable/enumerable 标记及地址大小写。
`market-params.ts` 独立声明同样的结构；类型检查验证它与 Reader 返回值完全匹配。
viem 解码的 uint8 到 uint48 保留 number；更大的 bigint 仅在 JSON 输出时转成十进制字符串。
无 inventory、params 包装层、旧基线或状态写入。
不能枚举的 manager 和第三方合约内部参数不采集；Spoke 的全部 reserve 均保留，
不递归扩展 API 未列出的 Hub。

变更监控先通过 `f/chain_sentinel/sources/previous` 读取 Source 最近成功 job，
再执行配置 Source。没有历史 job 时仅采集，不发通知。
有历史值时调用 `f/chain_sentinel/rules/diff` 比较 `previous.result` 与当前快照，
生成包含旧值的 JSON Patch；对象字段顺序忽略，数组按下标比较。
非空 Patch 经 inline Handlebars 模板渲染，再交给 notification Flow。
历史来自 Source job，不再维护独立 baseline 或 MonitorState；成功采集即进入历史，
即使后续比较或通知失败也不会撤回该次 Source 结果。
配置 Source 的 RPC 映射列出 Ethereum、Arc、Base、Avalanche。

本地验证：`bun run test`、`bun run check`，合约与 Anvil 验证见
[Reader 文档](../../contracts/aave-v4/README.md)。无状态只读采集预览：
`wmill script preview f/aave/scripts/workflows/collect_aave_v4_market_params.ts -d @<参数文件>`。
`taskScript` 按路径调用工作区脚本，正式路径预览需要两个 Source 脚本已部署；
验证未部署的本地子任务时，可在临时目录用伴随模块做隔离预览。
旧 Hub 资产、Hub–Spoke 额度、reserve、manager 分页 GraphQL 配置链路已删除。

清算 Flow 首次运行默认只建立基线，避免安装后补发全部历史记录。Aave V3 API 的历史接口要求
单个 Pool 地址，因此一个 V3 清算 Monitor 实例对应一个部署。Aave V3/V4 当前公开响应没有足够的
Oracle 更新时间/独立参考价或统一坏账字段；本轮不会把缺失值当 0，也不会伪造这两类判断。

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
