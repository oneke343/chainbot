# Chain Sentinel on Windmill

这是一个保持最小边界的组件化 Monitor Project。`aave`、`morpho`、`binance` 和 `chain_sentinel` 是独立的
项目边界，每个项目内部再按 Windmill 对象类型和职责组织：

- `f/chain_sentinel/scripts` 提供通用 AlertPolicy、Source 和 Destination 脚本。
- `f/chain_sentinel/lib` 提供共享的 MonitorState 函数和类型。
- `f/aave/scripts` 与 `f/aave/flows` 提供 Aave Monitor Sources、Rules 和 Flow。
- `f/binance/scripts` 与 `f/binance/flows` 提供币安现货价格 Monitor。
- `f/morpho/scripts` 与 `f/morpho/flows` 提供跨网络 Morpho Blue 用户借款仓位 HF Monitor。
- `f/aave/resources` 保存 Aave 示例 Resource。
- `f/binance/resources` 保存币安公共行情示例 Resource。
- 用户自己创建 Root Flow，组合 Monitor Flow、AlertPolicy、Destinations 和任意 Windmill Trigger。

没有额外的 Control Plane 或 MonitorInstance Resource。用户的 Root Flow 就是 Monitor Instance，
Root Flow Path 就是稳定的实例身份。

## 执行模型

Monitor 开发者实现的 Flow：

```text
Sources ──产生本次 inputs
        │
        ▼
Rule(inputs)
  ├─ getMonitorState()
  ├─ 计算新的 states + outputs
  ├─ setMonitorState({ inputs, states, outputs })
  └─ 只返回 MonitorOutput { matched, messages, fields }
```

用户创建的 Root Flow：

```text
Windmill Trigger
        │
        ▼
Aave/Binance/Morpho Monitor Flow
        │ MonitorOutput
        ▼
AlertPolicy
        │ AlertDecision { messages }
        ▼
用户在 Flow 中选择 Destination Sender
```

AlertPolicy 不知道 Destination。它只判断是否发送以及发送什么；Root Flow 决定发送到哪些
Destination；Sender 只负责协议投递。

## MonitorOutput 与 MonitorState

```ts
type MonitorOutput = {
  matched: boolean;
  messages: Array<{
    title: string;
    description: string;
    fields?: Record<string, unknown>;
  }>;
  fields: Record<string, unknown>;
};

type MonitorState = {
  inputs: Record<string, unknown>;
  states: Record<string, unknown>;
  outputs: MonitorOutput;
};
```

- `inputs`：Sources 本次执行产生的结果。
- `states`：Rules 需要跨运行保存的内部状态。
- `outputs`：Rules 本次产生的报警候选，必须包含 `matched`、`messages` 和 `fields`；具体
  Monitor 可以为多个独立风险项分别生成候选消息。
- Root Flow 和 Monitor Flow 的参数不保存在 MonitorState 中。

`f/chain_sentinel/lib/monitor-state.ts` 导出的 `getMonitorState()` 和 `setMonitorState()` 会取得
当前 Root Job 的 `script_path`，并把状态保存为：

```text
{rootFlowPath}/__monitor_state
```

它们是供 Rule import 的普通函数，不是独立 Windmill Flow 节点。状态读写和业务状态演进因此
处于同一个 Rule job 中。因此同一个 Root Flow 的 Schedule、Webhook 和手动执行共享状态；
复制成另一个 Root Flow 后会自然得到另一份状态。Root Flow 改名会改变状态路径。

`f/chain_sentinel/resource_types` 下的 `monitor_output.resource-type.yaml` 和
`monitor_state.resource-type.yaml` 分别定义公开 Rule 输出与内部持久化状态的 Windmill
Resource Type。
`setMonitorState()` 首次创建状态 Resource 时使用 `monitor_state` 类型；JSON Schema 和运行时
校验都会拒绝不符合 `MonitorOutput` 契约的数据。

## 通用 Position Risk Monitor

现有的 [Aave Monitor](f/aave/README.md)、[Morpho Monitor](f/morpho/README.md) 和
[SparkLend Monitor](f/spark/README.md)
自动发现用户跨网络的全部 API 已索引借款仓位，支持 `default_threshold` 与按可读市场名称
配置的 `market_thresholds`。两者都使用原生 GraphQL Source 和 TypeScript Rule：
Aave V4 三个 YAML Flow 节点（主网发现 → 仓位查询 → Rule），Morpho 两个节点（查询 → Rule）。
各协议实例应使用不同根 Flow，避免写入相同的 MonitorState。协议必须实现
`HealthPositionAdapter<Source>`，把原始 Source 结果规范化为 `HealthInputs`，然后复用
`f/chain_sentinel/lib/health-factor.ts` 中的通用仓位状态机。未来增加 Fluid 等协议时，只需新增
协议 Source、Adapter 和轻量 Rule wrapper，不复制阈值、趋势、去重和消息治理逻辑。
Morpho 使用原生 `.gql` 一次获取最多 1000 个仓位，Rule 检查返回数量是否完整；超限报错，
不静默漏监控、不自动分页。Aave V4 要求非空网络列表，因此先用独立 `.gql` 查询发现主网，
再把网络 ID 传给仓位查询，不写死链列表。

以下为原有 Aave V3 Monitor：

`f/aave/flows/aave_health__flow` 完整实现了 Monitor Flow 契约：

```text
Aave GraphQL Source
  → evaluate_aave_health（执行规则、写状态）
  → MonitorOutput
```

Rule 内部计算并保存完整的 MonitorState，但对外只返回：

```ts
type AaveHealthOutput = {
  matched: boolean;
  messages: Array<{
    title: string;
    description: string;
    fields?: Record<string, unknown>;
  }>;
  fields: {
    user: string;
    markets: Record<string, unknown>;
  };
};
```

通用 Position Risk Engine 支持五类 OR 关系风险信号：当前 HF 低于市场阈值、窗口内 HF
下降百分比、窗口内债务增长百分比、由 `1 - 1/HF` 估算的清算缓冲，以及可配置的统一压力场景。
趋势首次执行只建立基线；达到窗口后才判断。历史按分钟去重，最长窗口限制为 1440 分钟。
每个“规则 × 仓位”独立保存 active 状态。`risk_options` 支持 HF 恢复迟滞和定时重复提醒；
趋势规则支持 `rearm_percent`。历史按实际时间戳取窗口基线且每个仓位硬限制 120 个样本。

`message_policy.max_messages` 限制一次运行最多返回 1 到 100 条消息，默认 20；溢出策略
`summary` 会保留前面的明细并用最后一条汇总其余 finding，`truncate` 则只截断。完整仓位和
finding 仍保存在 `MonitorOutput.fields`。Rule 不决定 severity，也不知道 Destination。

示例高级规则：

```yaml
risk_rules:
  - id: hf_drop_5m
    kind: health_factor_drop
    window_minutes: 5
    threshold_percent: 10
  - id: debt_up_15m
    kind: debt_growth
    window_minutes: 15
    threshold_percent: 20
    min_debt_usd: 100
  - id: liquidation_buffer_15
    kind: liquidation_buffer
    threshold_percent: 15
stress_rules:
  - id: collateral_down_10
    collateral_change_percent: -10
    debt_change_percent: 0
    threshold: 1.05
risk_options:
  rearm_health_factor_margin: 0.05
  repeat_interval_minutes: 60
message_policy:
  max_messages: 20
  overflow: summary
```

`u/oneke` 的三个仓位实例已经启用 5/30 分钟 HF 下降、5/30/60 分钟债务增长和 -10% 抵押品
压力场景；这些是起始阈值，仍应按账户风险偏好调整。
`liquidation_buffer` 是假设其他条件不变时由 HF 推导的抵押品价格下跌缓冲估算，不是完整的
多资产压力测试。`stress_rules` 使用
`stressedHF = currentHF × (1 + collateralChange) ÷ (1 + debtChange)`；Morpho 单抵押品市场含义较清晰，
Aave 组合仓位仍是统一冲击近似值，输出会标记 `approximate: true`。

## 清算事件与 Market Risk

第二轮新增六个可复用 Monitor Flow，仍然只运行 Sources 和 Rules：

- `f/aave/flows/aave_v3_liquidations`、`aave_v4_liquidations` 与
  `f/morpho/flows/morpho_liquidations` 查询协议确认的清算事件。
- `f/aave/flows/aave_v3_market_risk` 监控 reserve 流动性、利用率、Supply/Borrow Cap 和暂停/冻结。
- `f/aave/flows/aave_v4_market_risk` 监控 Spoke 流动性、利用率与聚合 Cap。
- `f/morpho/flows/morpho_market_risk` 监控 Oracle warnings、已实现/未实现坏账、流动性和利用率。

清算 Monitor 首次运行默认只建立基线；随后使用稳定事件 ID 去重。Morpho 同时保存
`chainId + txHash + logIndex` 和每链最新 block；若返回页与旧游标不再重叠则失败，避免静默漏事件。
Aave API 没有在这些查询中提供 block/log index，因此使用协议活动 ID 或交易哈希及分页重叠保护。

Position、Liquidation 和 Market Risk 都会写 `{ROOT_FLOW_PATH}/__monitor_state`，必须分别放在独立
Root Flow 中，不能把多个有状态 Monitor 子 Flow 串在同一 Root Flow 下。Root Flow 再统一接
AlertPolicy 和批量 Destination。

## 通用 AlertPolicy

`f/chain_sentinel/scripts/alert_policies/matched_output` 是最小的通用策略：直接接收
`MonitorOutput`，为每个候选消息补充 severity，返回：

```ts
type AlertDecision = {
  messages: Array<{
    title: string;
    description: string;
    severity: "info" | "warning" | "critical";
    fields: Record<string, unknown>;
  }>;
};
```

其中 `message` 使用 `f/chain_sentinel/resource_types/alert_message.resource-type.yaml` 定义的
`AlertMessage` Resource Type，作为 AlertPolicy 和所有 Destination Sender 之间的统一契约。

AlertPolicy 可以产生多个 `messages`，不接收也不返回 Destination。每条最终消息固定包含
`title`、`description`、`severity`、`fields` 四个字段。Root Flow 把整个数组一次传给
Telegram、Webhook 或其他 Sender，不包含发送循环；空数组由 Sender 直接返回。

内置 Destination Sender 包含 Telegram、Webhook 和 FlashDuty。FlashDuty 使用标准告警事件
接口，将 `AlertMessage.severity` 映射为 `Critical`、`Warning` 或 `Info`，并把 `fields` 转换为
字符串 labels；可选的 `alert_key` 会在 Sender 内按 `finding_id` 扩展，用于 FlashDuty 独立聚合
批次内的每个告警。Sender 单批最多接收 100 条；Telegram 对同一 chat 顺序发送，FlashDuty
和 Webhook 使用最多 4 个并发请求。FlashDuty Resource 同时保存
标准告警 Endpoint URL 和 `integration_key`，Sender 不依赖硬编码地址。

## Project 结构

```text
f/
  chain_sentinel/        # 通用基座项目
    scripts/
      alert_policies/    # MonitorOutput → AlertDecision
      destinations/      # AlertMessage + Destination Resource → SendResult
      sources/           # 通用 Sources
    lib/
      destination-batch.ts # Destination 内部的有界批量投递
      health-factor.ts     # Adapter 契约、统一仓位风险规则和历史状态
      liquidation-events.ts # 清算事件游标、去重和消息
      market-risk.ts       # Oracle、坏账、流动性、利用率与 Cap 状态机
      monitor-state.ts   # get/set MonitorState 等共享函数与类型
      render-message.ts  # 使用 Monitor inputs + states 渲染 Monitor 自有模板
    resource_types/      # chain_sentinel 拥有的 Resource Type 定义
  aave/                  # Aave Monitor 项目
    scripts/
      sources/           # Aave Sources
      rules/             # Aave Rules，负责自身 MonitorState 读写
    flows/                # Aave Monitor Flows
    resources/            # Aave 示例连接配置
  binance/                # Binance Spot Monitor 项目
    scripts/
      sources/            # 已关闭的 1 分钟现货 K 线
      rules/              # 百分比变化、OR、去重与恢复
  spark/                  # SparkLend RPC Source、Adapter、Rule 和 Monitor Flow
    flows/                # 两节点 SparkLend Monitor Flow
    resources/            # SparkLend Pool/RPC Resource
```

`lib` 中的 `.script.yaml` / `.script.lock` 是 `wmill generate-metadata` 为同步和依赖解析生成的
伴随文件；`monitor-state.ts` 没有 `main`，不会作为业务 runnable 暴露，只通过相对 import 使用。

## 本地验证

```bash
npm test
npm run check
```

这些命令不会部署。需要运行真实 Flow 时使用本地 `wmill flow preview`；只有明确部署时才执行
项目所配置的部署流程。

## GitHub 与 Windmill 双向同步

`.github/workflows/windmill-sync.yml` 维护两条自动化链路：

- `main` 分支中的 `f/**`、`u/**`、`wmill.yaml` 或 `wmill-lock.yaml` 更新后，自动执行
  `wmill sync push`；
- 每 10 分钟执行一次 `wmill sync pull`，如果 Windmill workspace 有更新，则以
  `github-actions[bot]` 身份提交回 `main`。

GitHub 仓库必须配置 Actions secret `WMILL_TOKEN`。同步固定连接
`https://windmill.yeap.capital` 的 `chainbot` workspace，secret 只保存 Windmill token。

自动 push 如果检测到会删除 Windmill 对象，将停止而不部署。确认删除符合预期后，在 GitHub
Actions 页面手动运行 `Windmill sync`，选择 `push` 并启用 `allow_deletions`。如果 `main`
开启了禁止 Actions 直接 push 的分支保护，需要允许 GitHub Actions 写入，或将 pull job 改为
创建 Pull Request。
