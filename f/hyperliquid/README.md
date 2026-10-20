# Hyperliquid 账户仓位与清算风险

只读 Source、风险 Rule 和 Monitor，通过现有通知渠道发送 Telegram／FlashDuty 告警。

Source 使用官方 API 文档列出的社区 TypeScript SDK
[`@nktkas/hyperliquid`](https://github.com/nktkas/hyperliquid)，固定版本 `0.33.3`。
通过 `InfoClient` 查询，API 请求、类型和 HTTP 错误交给 SDK；不维护自定义 HTTP 包装。

## Source：`f/hyperliquid/sources/account_positions`

输入 `address`（实际持仓账户或子账户地址）、`network`（默认 `mainnet`）。
不需要密钥。代理钱包地址不能代替实际账户地址；主账户不自动包含子账户。

每次重新发现全部永续 DEX，包括默认 DEX 和 HIP-3 DEX；采集所有非零全仓、
逐仓仓位。最多同时采集 4 个 DEX，每个 HTTP 请求超时 8 秒。
有仓位时按 `meta.universe` 和资产上下文的对应关系取得 `markPx`，不使用中间价、
成交价或入场价代替标记价格。资产名称保留 DEX 前缀。

输出 `Snapshot`：

- `positions`：完整仓位标识、DEX、币种、保证金模式、带方向数量、标记价格、
  平台估计清算价、仓位价值、未实现盈亏和保证金占用。金额保留十进制字符串。
- `marginData.dexs`：各 DEX 的全仓权益、维持保证金要求及抵押资产 token。
- Unified／Portfolio 模式额外读取带 token id 的现货余额；没有抵押资产 token id
  的 outcome 余额不参与保证金池计算。
- 采集起止时间、账户状态时间、市场数据取回时间。市场数据接口没有逐价格时间戳，
  `marketFetchedAt` 仅表示 HTTP 数据取回时间，不证明报价刚刚更新。

接口响应按 SDK 的 TypeScript 类型直接使用，不重复验证字段、地址、数组或数值。
HTTP、网络、超时及运行错误直接抛给调用方；任何 DEX 采集失败都会使整个 Source
失败，不返回部分结果，也不把失败转换为空仓位。成功返回的快照包含全部 DEX。

## Rule：`f/hyperliquid/rules/liquidation_risk`

输入 `snapshot`、`config`、`evaluatedAt`（毫秒时间戳）。评估时间显式传入，
规则没有网络请求或持久化状态，相同输入得到相同输出。

配置示例仅用于演示，不是适用于所有账户的风险建议：

```json
{
  "minLiquidationDistance": "0.05",
  "maxMarginRiskRatio": "0.8",
  "maxSnapshotAgeMs": 60000
}
```

- 多仓距离：`(markPrice - liquidationPrice) / markPrice`。
- 空仓距离：`(liquidationPrice - markPrice) / markPrice`。
- 距离 `<= minLiquidationDistance` 触发，包括负数距离。
- Standard（API 返回 `disabled`）：每个 DEX 分别计算
  `crossMaintenanceMarginUsed / crossMarginSummary.accountValue`。
- Unified：按抵押资产归组，维持保证金跨 DEX 相加；分母为该 token 的现货
  `total` 减去对应逐仓仓位 `marginUsed` 之和。不能使用各 DEX 的账户权益做分母。
- 池级比例 `>= maxMarginRiskRatio` 触发。有全仓敞口但可支撑权益非正时直接触发，
  `metric` 为 `null`，不伪造有限比例或输出不可序列化的 Infinity。
- 不存在全仓敞口且维持保证金为零的池不产生池级检查。

每个仓位和保证金池独立返回 `CheckResult`，另有账户数据质量结果：

| status | 语义 |
| --- | --- |
| `breach` | 当前数据已经触线 |
| `clear` | 当前数据支持该对象未触线 |
| `unknown` | 数据过期、没有清算价估计或不支持的账户资金模式 |

Rule 同样信任输入接口与类型，不做运行时结构校验，不捕获计算错误。

金额计算与阈值比较使用原生 BigInt 十进制分数，不引入依赖；输出比例四舍五入到
小数点后 18 位。触发判断使用未舍入数值。价格距离和保证金比例的数值含义不同，
不能混用阈值。

### 必须保留的边界

- 逐仓独立检查，账户总体资金充足不会消除逐仓告警。
- `liquidationPrice: null` 表示距离无法计算，不解释为安全。
- 采集失败直接导致 Source 失败，调用方不能把失败视为无仓位或风险恢复。
- 数据过期／未来时间戳不产生 `clear`。整个采集周期超过时效预算也视为过期。
- Standard／Unified 池级计算已实现。`portfolioMargin`、`dexAbstraction`、
  `default` 或其他模式的池级检查明确返回 `unknown`。`default` 的实际资金口径
  未经核实，不擅自当作 Standard 或 Unified。逐仓位距离检查继续执行。
- 这不是同一区块的原子快照。账户状态与价格取回之间的变化仍可能造成偏差。
- 清算价是平台估计值，其他仓位、资金费率和资金变动会改变它。

Monitor 不把失败或 `unknown` 当作风险恢复。规则不自行生成“已恢复”事件。

## Monitor：`u/oneke/monitors/hyperliquid_liquidation_risk`

输入 `address`、`config`，以及默认 `mainnet` 的 `network`。

1. 调用 Source 读取该账户所有 DEX 的仓位。
2. 使用 Windmill `step` 保存本轮评估时间，重放时复用同一时间。
3. 调用 Rule，对所有仓位和保证金池进行检查。
4. 有 `breach` 或 `unknown` 时，将所有相关结果合并为一条 `error` 消息，调用
   `u/oneke/channels/notification`；只有 `clear` 时不通知。

现有通知 Flow 会将 `error` 消息发送至 Telegram 和 FlashDuty。
通知中包含账户、网络、评估时间、检查对象、状态、数值、阈值及原因。
采集、规则、时间步骤或通知失败均直接让本轮任务失败，不捕获或伪装成健康状态。

定时模板每 30 秒执行一次，禁止重叠，默认 `enabled: false`。启用前须替换全零
占位地址并配置自己的阈值。任务失败沿用工作区错误处理配置。
尚未实际发送通知或启用定时任务。

与现有 HF Monitor 一样，条件持续存在时每轮都会通知；工作流重放不会重复发送
已经完成的通知。这里没有实现跨轮告警去重、恢复事件、电话确认或重拨策略；这些
需要在通知服务中另外配置，不能将当前接入等同于已经验证电话叫醒链路。

## 人工验收

本地串联示例（不部署、不通知）：

```ts
import { main as collect } from "./sources/account_positions.ts";
import { main as evaluate } from "./rules/liquidation_risk.ts";

const snapshot = await collect("0x你的实际账户地址", "mainnet");
const results = await evaluate(snapshot, {
  minLiquidationDistance: "0.05",
  maxMarginRiskRatio: "0.8",
  maxSnapshotAgeMs: 60000,
}, Date.now());
console.log(JSON.stringify({ snapshot, results }, null, 2));
```

先对照 Hyperliquid 界面确认所有 DEX、仓位方向及全仓／逐仓模式；再复制快照修改
价格、清算价或时间戳，检查触线、缺清算价和过期情况；接口失败应直接报错。
无需调整真实仓位。标准 Windmill 运行参数入口由两个 `.script.yaml` 描述。

本地回归检查：

```bash
node --test --test-isolation=none test/hyperliquid-risk.test.ts
node --test --test-isolation=none test/hyperliquid-monitor.test.ts
```

## 接口依据

- [永续接口与字段](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)
- [账户模式与 Unified 风险计算](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/account-abstraction-modes)
- [清算规则](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations)
