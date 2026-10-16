# Aave monitors

## GraphQL 类型生成

在项目根目录运行 `bun run codegen`，递归扫描 `f/aave/**/*.gql`，按 API 版本生成
`f/aave/lib/v3-types.ts` 和 `f/aave/lib/v4-types.ts`，各自包含该版本所有查询的返回值与变量类型。
修改查询后重新运行，生成文件不要手改。
`sources/v3/` 与 `sources/v4/` 下的查询分别使用 V3 与 V4 schema；生成过程需要联网读取 schema。
配置在根目录 `codegen.ts`，地址、金额、时间等自定义 scalar 的 TypeScript 映射也在该文件中。

Source 仓位类型分别定义在 `sources/v3/types.ts` 和 `sources/v4/types.ts`。

`sources/v3/users_positions.ts` 使用 `taskScript("f/aave/sources/v3/user_positions")`
并行查询用户，返回按用户地址索引的仓位。查询位于
`sources/v3/user_positions.gql`，类型从 `lib/v3-types.ts` 导入。查询是独立 Windmill Script，
预览或运行 WAC 前需要部署该查询脚本。

V3 使用 `u/oneke/monitors/aave_v3_hf_alert`：通过 `sources/v3/users_positions` 采集，
再逐用户调用 `rules/aave_v3_hf`，将非空告警交给 `u/oneke/channels/notification`。
`thresholds` 按市场名称覆盖 `defaultThreshold`，默认忽略启用 eMode 的市场。
V4 使用 `u/oneke/monitors/aave_v4_hf_alert`，按用户在每个 Spoke 的整体账户监控 HF。

## V4 HF 告警 WAC

`u/oneke/monitors/aave_v4_hf_alert` 通过 `sources/v4/users_positions` 自动发现主网，
并行查询多个用户，再逐用户调用 `rules/aave_v4_hf`。Source 复用现有 V4 GraphQL Script，
返回 `user -> positions[]`，保留 HF 为 `0` 的仓位，跳过 HF 为 `null` 的仓位。

```yaml
users:
  - "0x166Ce42Df5f4BAA94aBC5B62C60dab1B3C73D2a3"
api: "$res:f/aave/resources/aave_v4"
defaultThreshold: 1.1
ltvThreshold: 90
thresholds:
  "Ethereum / Main": 1.2
  "Avalanche / AVAX Correlated": 1.05
```

`thresholds` 按 `chainName / spokeName` 精确匹配，未配置的 Spoke 使用 `defaultThreshold`。
`ltvThreshold` 是百分比，默认 `90`。Rule 使用 API 的 `averageCollateralFactor.normalized`
作为高 LTV 仓位的筛选指标，配置抵押因子达到或超过该阈值时忽略该仓位，类似 V3 的 eMode 忽略规则。
这里使用配置抵押因子，不是实际债务／抵押品比值，也不代表协议提供了 eMode 标记。
其余仓位判断 `HF < threshold`，等于 HF 阈值不命中。
每个命中用户返回一条包含用户、Spoke、网络、HF、配置抵押因子和实际阈值的 error 消息。
WAC 将非空消息交给 `u/oneke/channels/notification`，发送 Telegram 和 FlashDuty，并返回告警数组。

## Aave V3 配置变更

`u/oneke/sources/aave_v3_configuration` 绑定现有 V3 GraphQL Resource，调用
`f/aave/sources/v3/market_params`。采集 WAC 复用 `v3/chains` 发现主网，网络列表缓存一天，
再通过 `market_params_query.gql` 一次查询全部主网的配置，不缓存配置查询。
查询类型通过现有 Codegen 生成，不使用 SDK 默认 fragment。

快照结构为 `chainId → poolAddress → { name, reserves, eModeCategories }`。
资产和 eMode 集合按地址、类别 ID 索引，地址统一小写；比例和 cap 用 `raw + decimals`
无损转换为十进制字符串。保留 `borrowInfo`、旧隔离模式配置的 null。
不采集价格、APY、余额、利用率、奖励和采样时间，不额外验证 API 类型或添加兜底。
GraphQL 任务失败直接传播，Source 不返回部分快照。

`u/oneke/monitors/aave_v3_configuration_change` 与 V4 一样，先读取最近成功 Source job，
再采集、调用通用 diff，并将非空变化交给现有 notification Flow。
首次采样不通知；Source 成功即进入历史，后续通知失败不回滚基线。
需补发时恢复失败 Monitor 的通知 checkpoint，下一轮采样不自动补发旧变化。

Schedule 每三分钟第 12 秒执行、禁止重叠，已启用（`enabled: true`）。
纯 GraphQL 仅监控 API 支持的配置采样差异，不代表链上逐笔修改或升级、权限审计。
完整字段和范围见 [V3 配置监控设计](V3_CONFIGURATION_PLAN.md)。

## Aave V3 Reserve 指标监控

`u/oneke/sources/aave_v3_market_metrics` 绑定 V3 GraphQL Resource，调用
`sources/v3/market_metrics.ts`。先发现主网（缓存一天），再通过一个
`market_metrics_query.gql` 查询所有目标链和市场。Source 返回 `ReserveSnapshot`：
`{ sampledAt, reserves }`，Reserve 按 `chainId/小写市场地址/小写底层资产地址` 索引。
金额和比率保留 `raw + decimals`；`sampledAt` 在查询完成后通过 WAC `step` 固定，
表示采集时间，不是链上区块时间。

`u/oneke/monitors/aave_v3_market_risk` 先采集，再经
`f/chain_sentinel/sources/history` 读取最近 30 分钟成功 Source job。
通用历史入口按 job 开始时间过滤；Rule 按快照采样时间排序并排除当前及未来采样。
基准选取当前时间减 15 分钟时点或之前最近的一条，最多提前 3 分钟，
实际比较间隔为 15～18 分钟。没有符合条件的基准时，本轮不产生风险告警。

默认阈值均使用 bps（100 bps = 1% 或 1 个百分点），比较包含阈值本身：

| 配置项 | 默认值 | 条件 |
| --- | --- | --- |
| `liquidityChangeBps` | 2000 | 可用流动性增加或减少至少 20% |
| `borrowApyRiseBps` | 200 | 借款 APY 上涨至少 2 个百分点，无当前 APY 上限 |
| `supplyDropBps` | 1000 | 总供给减少至少 10%，无金额过滤 |
| `borrowGrowthBps` | 1000 | 总借款增加至少 10%，无金额过滤 |

各规则比较基准与当前快照，中间有采样缺口时仍可判断。
基准余额为零时跳过对应百分比变化。
`borrow: null` 的 Reserve 仍判断供给减少。

Monitor 接收 `config`，由 `defaults` 和按 Reserve key 索引的 `overrides` 组成：

```yaml
config:
  defaults:
    liquidityChangeBps: 2000
    borrowApyRiseBps: 200
    supplyDropBps: 1000
    borrowGrowthBps: 1000
  overrides:
    "1/0x市场地址/0x资产地址":
      liquidityChangeBps: 2500
```

同一 Market 下所有命中资产的指标合并成一条通知，按链 ID 和市场地址分组，跨链或不同地址的同名市场分别发送。
findings 自带 marketName 和 assetName（底层 token 全名），标题展示市场名称，描述按资产分段；reserveKey 仅用于内部分组。
`renderNotifications(findings)` 仅使用 findings，通过共享 `f/handlebars/render` 按市场、资产遍历，
展示 metric、方向、前后值、变化和 bps 阈值。金额添加千分位并最多显示 4 位小数；APY、利用率和余额变化显示为百分比，最多 2 位小数。
APY 变化使用 pp（百分点），例如 0.02 显示为 2 pp；极小非零值用科学计数法显示。
通知数据在传入模板前统一格式化，模板只遍历和展示；Source、findings 和阈值计算保持原始精度。
每个触发资产只返回一条 Finding：`metrics` 保存全部命中指标，`currentValues` 保存一份本次采样的全部指标。
资产名称、市场名称和当前值不在每条命中指标中重复；通知在每个触发资产下展示一次当前指标，
包含采样时间、token 单位、供给量、Supply Cap，以及借款量、可用流动性、利用率、利率拐点、借款 APY 和 Borrow Cap。
未触发的指标也展示，未触发的资产不展示；`borrow: null` 时仅展示供给相关指标。
Source 保留 Supply / Borrow Cap 数据供容量查看，动态风险 Monitor 不根据 Cap 使用率告警；
Cap 参数变化继续由 `aave_v3_configuration_change` 通知。
Source 保留利用率和利率拐点数据，动态风险 Monitor 不根据高利用率告警。
流动性增加为 info，其余为 warning；市场内任意指标为 warning 时整条通知为 warning，经现有渠道发送 Telegram。
持续命中每轮继续通知；失败直接传播，Source 历史不因通知失败而撤回。
Schedule 每三分钟第 42 秒运行，Asia/Shanghai、禁止重叠，已启用（`enabled: true`）。
调度启用状态在推送 `main` 后由 GitHub Actions 同步到 Windmill。

新查询类型已通过官方 SDK schema
[`801260c`](https://github.com/aave/aave-sdk/blob/801260c39921177c56f62d1f1e0d51971e9fd4bc/packages/graphql/schema.graphql)
验证及生成；环境可访问 API 后，可通过根目录 Codegen 刷新为在线 schema。
只读采集预览：`wmill flow preview u/oneke/sources/aave_v3_market_metrics -d '{}'`。

## Aave V4 配置变更

配置采集由 `u/oneke/sources/aave_v4_configuration` 调用采集 WAC，
变更监控由 `u/oneke/monitors/aave_v4_configuration_change` 编排。
结果直接采用 Reader 的对象图：`Record<chainId, Record<hubAddress, HubGraph>>`。
`HubGraph` 保留 `hub`、`spokes`、`treasuries`、`tokenizations`、`otherSpokes`、`authorities`，
实体集合保留 Reader 数组，不转换成另一套领域对象，不跨 Hub 合并共享配置。
字段含义、单位和公开接口边界见 [Aave V4 协议配置](MARKET_PARAMS.md)。

采集 Workflow as Code `f/aave/sources/v4/market_params`
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
非空 Patch 经 `renderJsonDiff` 分组渲染，再交给 notification Flow。
历史来自 Source job；成功采集即进入历史，
即使后续比较或通知失败也不会撤回该次 Source 结果。
配置 Source 的 RPC 映射列出 Ethereum、Arc、Base、Avalanche。

本地验证：`bun run test`、`bun run check`，合约与 Anvil 验证见
[Reader 文档](../../contracts/aave-v4/README.md)。无状态只读采集预览：
`wmill script preview f/aave/sources/v4/market_params.ts -d @<参数文件>`。
`taskScript` 按路径调用工作区脚本，正式路径预览需要两个 Source 脚本已部署；
验证未部署的本地子任务时，可在临时目录用伴随模块做隔离预览。
旧 Hub 资产、Hub–Spoke 额度、reserve、manager 分页 GraphQL 配置链路已删除。

只覆盖 API 已索引的仓位和部署，不等同于全链实时扫描。`observed_at` 是 Rule 检查时间，
不是链上区块时间。目标地址必须是持仓地址，不能由 EOA 自动推断其关联智能钱包。
API 零债务与 null HF 的解释依赖索引器，不是独立链上验算。

API：<https://api.v4.aave.com/graphql>；架构说明：
[Aave Pro User Guide](https://aave.com/blog/aave-pro-user-guide)。

本地检查在项目根目录运行 `npm test`、`npm run check`。
在 Windmill 中只读测试 Source 可使用
`wmill script preview f/aave/sources/v4/chains.gql -d '<包含 api 的 JSON>'`，
再运行 `wmill script preview f/aave/sources/v4/user_positions.gql -d '<包含 api、user、非空 chain_ids 的 JSON>'`。
