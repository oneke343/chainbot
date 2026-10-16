# Aave V3 纯 GraphQL 配置监控设计

日期：2026-10-16。状态：已在本地实现，未部署。Schedule 默认关闭。

实现遵循用户补充要求：信任 API 和生成类型，不添加运行时 schema 校验、重复数据检查、空结果保护、自动重试或兜底。合法的 nullable 字段按接口处理，任务和转换错误直接传播。

## 目标与调用方式

每三分钟采样官方 V3 GraphQL 支持的主网市场，比较常用风险参数、利率曲线、eMode 与操作开关，有变化时通过现有 notification Flow 通知。记录的是 API 采样变化，不声称捕捉每笔治理修改，也不填入推测的链上交易或执行时间。

正常调用只运行无参数监控入口。API Resource 绑定在无参数 Source Flow 中，与 V4 相同；无需给监控入口传入 API、网络、历史值或通知参数。

调用路径如下：

```text
定时任务 → u/oneke/monitors/aave_v3_configuration_change()
  → previous(source_path = V3 Source Flow 路径)
  → u/oneke/sources/aave_v3_configuration()
      → f/aave/sources/v3/market_params(api)
          → 现有 v3/chains，发现主网
          → 一次调用 market_params_query(api, chain_ids=全部主网 ID)
          → 投影并返回完整快照，Source 成功结果进入历史
  → 现有 diff(before=previous.result, after=current)
  → 现有 renderJsonDiff
  → 现有 notification Flow
  → Monitor 结束，不承担快照持久化
```

## 1. 从 V4 复用什么

现有 [V4 Monitor](../../u/oneke/monitors/aave_v4_configuration_change.ts) 先读历史，再执行 Source，调用通用 diff，非空结果通过 notification Flow 发送。

- 编排继续使用 Bun Workflow as Code 和 `taskScript` / `taskFlow`，将 I/O 留在独立子任务中，保留 Windmill checkpoint。
- 复用 `f/chain_sentinel/sources/previous`、`f/chain_sentinel/rules/diff`、`renderJsonDiff` 和 `u/oneke/channels/notification`，不复制比较、渲染或发送逻辑。
- 采集结果与历史保存在 Windmill job result，不增加 SQLite、数据库表、资源状态、WebSocket、Subgraph、RPC 或额外的持久化服务。
- 查询放在 `f/aave/sources/v3/*.gql`，沿用根目录 `codegen.ts` 自动生成的 `f/aave/lib/v3-types.ts`；不增加 `@aave/client` 依赖。

V4 的数据源为 GraphQL 发现 Hub 后通过 RPC Reader 采集。V3 本期只使用 GraphQL，完整配置快照由 API 的字段投影构成，不调用 V4 Reader。

## 2. 组件及所有权

以下实体已在本地实现。Source Flow 使用 Windmill CLI 创建，尚未部署。

| 路径 | 输入、输出与责任 |
| --- | --- |
| `f/aave/sources/v3/market_params_query.gql` | 输入 GraphQL Resource 与非空 `chain_ids`；一次请求所选全部链的市场配置，返回生成类型 `AaveV3MarketParamsQuery`。不做状态管理 |
| `f/aave/sources/v3/market_params.ts` | Bun WAC，输入 `api: RT.Graphql`；发现网络，一次批量查询，按返回的 `chain.chainId` 分组，投影后返回 `Snapshot`。拥有快照结构与数值标准化规则 |
| `u/oneke/sources/aave_v3_configuration` | 无参数 Flow，将现有 `f/aave/resources/aave_v3` Resource 传给采集 WAC；只绑定部署配置 |
| `u/oneke/monitors/aave_v3_configuration_change` | 无参数 Bun WAC，先读最近成功 Source 的快照，再采集、比较、通知。与 V4 相同，不返回快照、不管理独立基线 |
| 同 Monitor 的 `.schedule.yaml` | 三分钟一次、禁止重叠、使用 Asia/Shanghai；默认关闭，尚未部署 |

快照类型在 V3 `market_params.ts` 中定义并导出，API 数据类型从生成的查询类型推导。投影和十进制标准化函数放在同一模块内；第一版不另建 prepare / normalization / assembler 任务或通用数值框架。

### 网络范围

复用现有 `f/aave/sources/v3/chains.gql` 的 `MAINNET_ONLY` 查询；网络发现结果沿用 V3 仓位 Source 的一天任务缓存。配置查询不启用任务结果缓存。

`markets(request: { chainIds: $chain_ids })` 本身支持多个链 ID。发现主网后，将全部 ID 一次传入配置查询，再按每个 market 返回的 `chain.chainId` 分组。每个市场请求 `reserves(request: { reserveType: BOTH })`。不传 `user`，不采用 SDK 默认 fragment，也不按 SUPPLY / BORROW 分别查询后合并。这样可以显式选取 `isolated`、`hasLtvZero`，并避免重复读取同一资产。

首版只执行一个全链配置查询子任务，不按链创建并行任务。配置查询超时建议 60 秒，Source 总超时 180 秒。请求失败或返回 GraphQL errors 则整轮失败。只有实际观测到响应体积、查询复杂度或超时限制后，再考虑分批；目前不增加批处理或逐链重试逻辑。一次跨链 API 请求也不代表所有字段来自同一区块或同一时刻。

发现新主网可能最多滞后一天。此时后续快照中的网络新增是 API 监控范围新增，不等同于该链协议刚部署。

## 3. 字段白名单

只请求和保存以下字段。HTTP / GraphQL 由原生查询任务处理，Source 不包装错误。

| 对象 | 纳入快照 |
| --- | --- |
| Market | `name`；使用 `chain.chainId`、Pool `address` 建索引 |
| Reserve 身份 | underlying 地址作为索引；`symbol`、`decimals`、`aToken.address`、`vToken.address` |
| Reserve 操作开关 | `isFrozen`、`isPaused`、`flashLoanEnabled` |
| Reserve 关联地址 | `usdOracleAddress`、`interestRateStrategyAddress` |
| `supplyInfo` | `maxLTV`、`liquidationThreshold`、`liquidationBonus`、`canBeCollateral`、`supplyCap` |
| `borrowInfo` | `reserveFactor`、`borrowCap`、`borrowingState`、`baseVariableBorrowRate`、`variableRateSlope1`、`variableRateSlope2`、`optimalUsageRate` |
| `isolationModeConfig` | 旧版兼容的 `canBeCollateral`、`canBeBorrowed`、`debtCeilingDecimals`；`debtCeilingUsd` 读取 `debtCeiling.usd` 并以整数分归一化，保留可空语义；不读取 token 换算数量及 `totalBorrows` |
| eMode category | category ID 作为索引；`label`、`maxLTV`、`liquidationThreshold`、`liquidationPenalty`、`isolated` |
| category 资产关系 | underlying 地址作为索引；`canBeCollateral`、`canBeBorrowed`、`hasLtvZero` |

不重复保存 reserve 的 `eModeInfo[]`，关系由 category 的资产集合统一表达。否则同一参数可能在两个位置产生重复告警。

不采集 APY、利用率、余额、USD 汇率、USD cap 估值、size、total、available liquidity、capReached、用户状态、奖励和采集时间。这些值不属于本期配置 diff。市场名、symbol 和 token decimals 是有意保留的身份元数据，其修改也会作为 API 数据变化通知。

公开 schema 依据：[Reserve 与利率](https://github.com/aave/aave-sdk/blob/801260c39921177c56f62d1f1e0d51971e9fd4bc/packages/graphql/schema.graphql#L1262-L1486)、[eMode](https://github.com/aave/aave-sdk/blob/801260c39921177c56f62d1f1e0d51971e9fd4bc/packages/graphql/schema.graphql#L267-L328)。接入时用线上 schema 执行 Codegen，验证实际字段兼容性；当前环境尚未完成线上端点调用验证。

## 4. 快照契约

```text
Snapshot = chainId → poolAddress → MarketConfiguration

MarketConfiguration
  name
  reserves: underlyingAddress → ReserveConfiguration
  eModeCategories: categoryId → EModeCategoryConfiguration

ReserveConfiguration
  symbol, decimals, aToken, vToken
  usdOracleAddress, interestRateStrategyAddress
  isFrozen, isPaused, flashLoanEnabled
  supplyInfo: 白名单参数
  borrowInfo: null 或白名单参数
  isolationModeConfig: null 或旧隔离模式配置

EModeCategoryConfiguration
  label, maxLTV, liquidationThreshold, liquidationPenalty, isolated
  reserves: underlyingAddress → { canBeCollateral, canBeBorrowed, hasLtvZero }
```

集合使用对象而不是数组。这是针对现有通用 diff 按数组下标比较的必要适配，不新增专用 diff 算法。

身份规范如下：chain ID 和 category ID 使用十进制字符串键；地址统一小写，包括关联地址字段。信任 API 的身份及唯一性约定，直接通过 `Object.fromEntries` 建立索引，不增加地址或重复项检查。

查询 PercentValue 时选取 `raw` 与 `decimals`，通过现有 viem 的 `formatUnits(BigInt(raw), decimals)` 无损转换成规范十进制字符串；金额使用 `TokenAmount.amount.raw/decimals`，转换成 token 数量字符串。不使用浮点 `Number`，不使用 `formatted` 或 `usd`。

例如 `raw="8000", decimals=4` 的比例保存为 `"0.8"`，金额 `raw="100000000", decimals=6` 保存为 `"100"`。清除无意义的前导和末尾零，避免 `"0.80"` 与 `"0.8"` 误报。零仍是字符串 `"0"`，不转为 null。

比例沿用 API 数值语义，`1` 表示 100%。`liquidationBonus` / `liquidationPenalty` 不擅自加减本金倍率；实际 schema 和响应的含义需在接入验收中确认。

合法的 `borrowInfo: null` 与 `isolationModeConfig: null` 原样保留，不补零、不合并为零参数对象。监控只报告该 API 对象的变化，不能据此断言所有链上借款参数已被读取。

快照不放 `observedAt`、耗时、子任务 ID、错误字符串或可变 coverage 摘要，避免每轮产生 diff。采样时间和状态使用 Windmill job 元数据，运行日志记录各链市场数与资产数。

## 5. 历史基线与通知失败

按用户确认的简单优先原则，V3 与 V4 一致，使用最近成功的 Source Flow job result 作为唯一快照基线。Monitor 只编排比较和通知，不将自身结果用于历史比较，也不新增通知确认状态或补偿状态。

顺序必须是：读取 previous → 采集 current → diff → 必要时通知 → 结束。历史读取必须发生在执行本轮 Source 之前，避免读到当前快照与自身比较。

- 首次成功采集：Source 结果进入历史；Monitor 不做 diff、不通知，直接结束。
- 无变化：Source 结果照常进入历史；Monitor 直接结束，可返回 `undefined`。
- 有变化：Source 成功后基线已经推进；Monitor 生成 diff 并发送通知。
- 历史读取失败：Monitor 失败，不执行本轮采集。
- 采集任务或数值转换失败：Source 和 Monitor 失败，不产生新成功 Source 基线。
- diff 或通知失败：Monitor 失败，但已经成功的 Source 结果保留，基线不回滚。

例如成功基线 A，采集 B 后通知失败；下一轮会将最新值与 B 比较，不会自动补发 A→B。补发需要恢复失败 Monitor 的 checkpoint，继续处理其已记录的 A、B 和 diff；不能把重新开始一轮采样等同于重试原通知。

Source job 同时保存采集证据和历史基线，成功采集即推进，不与通知是否成功绑定。代价是调度下一轮不能保证补发失败通知，这是本期明确接受的取舍。

通知尝试可能重复，不承诺 exactly-once。下游已收到消息但响应丢失时可能重复。禁止同一路径并发采集，手工测试使用隔离 Source 路径，避免测试采样混入正式历史。补发失败通知时复用 checkpoint 中已完成的采集，不重新执行旧轮次的 Source。

Windmill job 历史保留时间决定基线可恢复范围。历史被清理后按首次运行处理；长期归档不在第一版新增基础设施。

## 6. 错误及范围变化

- 网络发现或配置查询任务失败，错误直接传播，不返回部分快照，也不沿用旧数据。
- 对返回值直接按生成类型处理，不添加必选字段、地址、重复身份或空列表检查。错误数据在实际访问或转换时自然失败，不捕获异常。
- 为所有请求的链预先建立空对象，再按返回的 chain ID 填入 markets；某链没有 market 时保留空对象。空结果不增加特别保护。
- `borrowInfo` 与旧隔离模式配置的 null 是接口允许的值，原样保留。
- 市场或资产在成功响应中消失时按快照删除比较，不把这一变化认定为链上下架。
- 不增加自定义重试、连续两次确认、pending 删除集或自动恢复旧值。

Windmill 原生 GraphQL runner 对 errors 与 data 并存响应的线上行为尚未实测。本实现使用仓库既有原生 GraphQL Script 机制，不另写 HTTP 适配器。

## 7. 通知与调度

沿用 `level: "info"`，标题建议 `Aave v3 configuration snapshot changed`。描述使用现有 `renderJsonDiff`，开头或结尾补一句“比例 1=100%；debtCeilingUsd 单位为 USD，其余金额单位为 token；变化来自 API 两次采样”。

已有渲染器默认最多显示 20 项、2800 字符，完整 Patch 留在 diff 子任务结果中；不为 V3 另建发送器或风险分级。现有 notification Flow 会将 info 发往 Telegram，error 另发 FlashDuty，本文不执行任何通知。

采集失败走失败 job 和现有 workspace error handler，不伪装成配置变化通知。

建议每三分钟运行，错开 V4 的第 2 秒，可用第 12 秒。启用 `no_flow_overlap`，时区 Asia/Shanghai。采样频率是设计值，不代表 API 的缓存更新 SLA。网络发现缓存一天，配置查询不缓存。

## 8. 实施与验证

1. 新增配置查询和其 Windmill 元数据；执行现有 Codegen，确认新版 eMode、利率及旧兼容字段受线上 schema 支持。
2. 实现采集 WAC 内的无损数值投影和按身份索引；新增 Source Flow，绑定现有 V3 Resource。
3. 实现 Monitor，复用历史、diff、渲染和 notification；历史读取指向 Source Flow，保持 V4 的返回行为。先不启用 schedule。
4. 完成隔离只读采集预览及本地测试后，再按用户授权部署并启用调度。实体路径和元数据处理遵守 AGENTS.wmill.md，不绕过 git push 部署流程。

测试至少覆盖：

- 资产、市场及 eMode 返回顺序不同，diff 为空；地址仅大小写变化，diff 为空。
- 同一 symbol 的不同资产和相同地址跨链都不冲突，按实际身份索引。
- 修改 LTV、cap、利率 slope、isolated、hasLtvZero，得到准确字段 old/new。
- APY、余额、USD 价格变化不进入快照；数值超过安全整数范围仍无精度损失。
- 相同比例或金额的不同文本精度表示不误报；零、null、缺失分别处理。
- 配置查询只有一个子任务，变量包含全部主网 ID；响应按真实 chain ID 分组，不依赖返回顺序。
- 网络发现和全链查询任务失败直接传播，不返回部分快照。
- 首轮只采集、不通知；无变化时 Monitor 直接结束；历史读取发生在当前 Source 执行之前。
- Source 失败不推进基线；Source 成功但 diff 或通知失败时基线仍推进，下一轮不自动补发旧变化。
- 恢复失败 Monitor 的通知 checkpoint 不重新采集，不改变已保存的前后快照。
- WAC 重放复用已完成子任务，工作流函数体不直接发送 HTTP 或通知。
- 回归现有 V3 HF、V4 配置、历史读取、通用 diff 和 notification 测试。

已增加采集和监控测试，覆盖上述核心行为。完整测试与仓库检查的实际结果见实现交付说明。直接访问线上 Aave API 被当前环境网络代理拒绝，查询和类型使用前序调研固定的官方 schema 验证和生成；尚未执行线上 Windmill 预览，也未发送通知或部署。

## 仓库依据

- [V4 Monitor](../../u/oneke/monitors/aave_v4_configuration_change.ts)，重点为读取 Source 历史、生成 diff 和通知后的返回行为。
- [V4 采集 WAC](sources/v4/market_params.ts) 和 [Source Flow](../../u/oneke/sources/aave_v4_configuration__flow/flow.yaml)。
- [V3 主网发现及现有 WAC](sources/v3/users_positions.ts)。
- [历史读取](../chain_sentinel/lib/source-tm.ts) 与 [成功 job 查询](../wmm/wm_job_history.ts)。
- [通用 diff 与渲染](../chain_sentinel/lib/jsondiff.ts)。
- [通知 Flow](../../u/oneke/channels/notification__flow/flow.yaml) 与 [V4 schedule](../../u/oneke/monitors/aave_v4_configuration_change.schedule.yaml)。
- [Codegen](../../codegen.ts) 与 [V4 Monitor 测试](../../test/aave-v4-configuration-change.test.ts)。
