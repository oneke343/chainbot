# Binance Spot Price Monitor

本目录实现币安现货交易对的分钟级价格变化监控。它是一个 Monitor-specific Project，只包含
币安行情 Source、价格规则和 Monitor Flow；AlertPolicy 与 Destination 继续复用
`f/chain_sentinel`。

## 执行结构

```text
任意 Windmill Trigger
        │
        ▼
f/binance/flows/spot_price_change
  ├─ spot_klines
  └─ evaluate_spot_price_change + MonitorState
        │ MonitorOutput
        ▼
f/chain_sentinel/scripts/alert_policies/matched_output
        │ AlertMessage
        ▼
Root Flow 选择的 Destinations
```

Monitor Flow 只有两个 job 节点。Source 一次取得最大规则窗口所需的全部 K 线，Rule 在同一次
执行中评估所有规则、读写状态并生成消息。

## Flow 输入

```yaml
connection: $res:f/binance/resources/spot_market_data
symbol: BTCUSDT
rules:
  - id: drop_5m
    window_minutes: 5
    direction: down
    threshold_percent: 3
    rearm_percent: 2.5

  - id: rise_15m
    window_minutes: 15
    direction: up
    threshold_percent: 5
    rearm_percent: 4

  - id: move_60m
    window_minutes: 60
    direction: either
    threshold_percent: 8
    rearm_percent: 7
```

规则之间是 OR。每条规则还可以设置 `min_quote_volume` 和 `min_trade_count`，它们是该规则的
确认条件：

```text
(price condition AND optional liquidity conditions) OR another rule
```

`id` 是持久状态的稳定身份。修改同一个 `id` 的窗口、方向或阈值时，Rule 会通过配置指纹将其
视为重新配置，避免错误继承旧的 active 状态。

## 价格语义

第一版固定使用币安 REST API 返回的、已经关闭的 1 分钟 K 线。对于 `a` 分钟窗口：

```text
changePercent = (latestClosedPrice / priceAClosedMinutesAgo - 1) × 100
```

方向判断：

```text
up:     changePercent >= thresholdPercent
down:   changePercent <= -thresholdPercent
either: abs(changePercent) >= thresholdPercent
```

Source 会过滤尚未关闭的 K 线，并验证时间连续性、数据新鲜度和历史长度。最大窗口限制为 998
分钟，因为一次请求还需要容纳当前未关闭 K 线和窗口起点。

## 去重与恢复

Rule 使用 Root Flow Path 下的 MonitorState 保存每条规则的 active 状态：

```text
inactive ──达到 threshold──▶ active + 产生一次 MonitorOutput.matched
active   ──仍未恢复────────▶ active + 不重复报警
active   ──回到 rearm──────▶ inactive
```

`rearm_percent` 必须小于 `threshold_percent`；省略时默认使用 threshold 的 80%。这形成滞后区间，
避免价格在阈值附近抖动时反复报警。

MonitorOutput 的 `matched` 表示“本次至少有一条规则新进入 active”，而不是“当前仍有规则处于
active”。多条规则同时触发时只生成一个 message，description 表格会展示所有规则的变化率、
阈值和状态。

## Root Flow 组合

用户的 Root Flow 负责选择 Trigger、Severity 和 Destinations：

```text
Trigger
  → f/binance/flows/spot_price_change
  → f/chain_sentinel/scripts/alert_policies/matched_output
  → Telegram / FlashDuty / Webhook
```

建议分钟级 Schedule 使用 `0 */1 * * * *`，并禁止 Root Flow 重叠执行。MonitorState 当前是
Resource 的 read-modify-write，没有数据库事务；同一 Root Flow 并发执行可能覆盖状态。

Source 出错时 Flow 应失败且不更新状态。Destination 应在 Root Flow 中单独配置 retry，从而用
当前 Flow 已经生成的 AlertMessage 数组重试投递。Root Flow 不再为消息创建 `forloopflow`，
批量拆分属于 Destination 内部实现。

## 已配置的用户实例

`u/oneke/binance_btcusdt_price_monitor` 是 Telegram-only 的 Root Flow，依次调用 Monitor、
`matched_output` AlertPolicy 和 `send_telegram`，使用上面的三条 BTCUSDT 示例规则，Severity
为 `warning`。Telegram 使用已有 Resource `u/oneke/yeap-bot` 和现有群聊。

对应的 `u/oneke/binance_btcusdt_price_monitor.schedule.yaml` 每分钟触发一次
（`0 */1 * * * *`，`Asia/Shanghai`），设置 `no_flow_overlap: true` 跳过重叠的定时运行。
这不限制手动执行与其他 Trigger；操作时应避免同时运行同一个 Root Flow。
发送步骤单独重试，未命中时 Sender 收到空消息并直接返回。
状态路径为 `u/oneke/binance_btcusdt_price_monitor/__monitor_state`。

## 后续扩展

新的价格语义可以作为 Rule 的 `mode` 增量加入：

- `drawdown`：当前价格相对窗口最高价的回撤。
- `runup`：当前价格相对窗口最低价的上涨。
- `range`：窗口最高价和最低价的振幅。
- `price_cross`：固定价格向上或向下穿越。

秒级监控应作为另一个 Monitor Flow，通过 WebSocket Trigger 和专门的时序存储实现，不应把
高频价格序列写入当前 JSON MonitorState。
