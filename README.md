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
  └─ 只返回 MonitorOutput { matched, message?, fields }
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
        │ AlertDecision { message? }
        ▼
用户在 Flow 中选择 Destination Sender
```

AlertPolicy 不知道 Destination。它只判断是否发送以及发送什么；Root Flow 决定发送到哪些
Destination；Sender 只负责协议投递。

## MonitorOutput 与 MonitorState

```ts
type MonitorOutput = {
  matched: boolean;
  message?: {
    title: string;
    description: string;
  };
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
- `outputs`：Rules 本次产生的报警候选，必须包含 `matched` 和 `fields`；具体 Monitor 在命中时
  负责生成可选的 `message.title` 与 `message.description`。
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

## Aave Monitor

新增的 [Aave V4 Monitor](f/aave/README.md) 和 [Morpho Monitor](f/morpho/README.md)
自动发现用户跨网络的全部 API 已索引借款仓位，支持 `default_threshold` 与按可读市场名称
配置的 `market_thresholds`。两者都使用原生 GraphQL Source 和 TypeScript Rule：
Aave V4 三个 YAML Flow 节点（主网发现 → 仓位查询 → Rule），Morpho 两个节点（查询 → Rule）。
两个协议实例应使用不同根 Flow，避免写入相同的 MonitorState。
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
  message?: {
    title: string;
    description: string;
  };
  fields: {
    user: string;
    markets: Record<string, unknown>;
  };
};
```

Aave 在 Rule 内定义自己的 description 模板，并调用通用的
`f/chain_sentinel/lib/render-message.ts`，以本次 MonitorState 的 `inputs + states` 作为模板
上下文。生成的 description 包含账户、触发市场摘要，以及所有已配置市场的 Current HF、
Threshold 和状态表格。Rule 不决定 severity，也不知道 AlertPolicy 和 Destination。

## 通用 AlertPolicy

`f/chain_sentinel/scripts/alert_policies/matched_output` 是最小的通用策略：直接接收
`MonitorOutput`，在命中且存在 Rule message 时补充 severity，返回：

```ts
type AlertDecision = {
  message?: {
    title: string;
    description: string;
    severity: "info" | "warning" | "critical";
    fields: Record<string, unknown>;
  };
};
```

其中 `message` 使用 `f/chain_sentinel/resource_types/alert_message.resource-type.yaml` 定义的
`AlertMessage` Resource Type，作为 AlertPolicy 和所有 Destination Sender 之间的统一契约。

每次 AlertPolicy 最多产生一个 `message`：命中时返回消息，未命中时不返回该字段。它不接收
也不返回 Destination。最终消息固定包含 `title`、`description`、`severity`、`fields` 四个
字段。Root Flow 可以把可选的 `message` 直接传给 Telegram、Webhook 或其他 Sender；
Destination 收到空值时会立即返回，不执行连接参数校验或网络请求。

内置 Destination Sender 包含 Telegram、Webhook 和 FlashDuty。FlashDuty 使用标准告警事件
接口，将 `AlertMessage.severity` 映射为 `Critical`、`Warning` 或 `Info`，并把 `fields` 转换为
字符串 labels；可选的 `alert_key` 用于 FlashDuty 聚合同一个告警。FlashDuty Resource 同时保存
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
    flows/                # 两节点 Binance Monitor Flow
    resources/            # 公共 Market Data HTTP Resource
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
