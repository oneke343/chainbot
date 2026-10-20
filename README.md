# Chainbot on Windmill

本项目使用 Windmill Source、Rule 与 Workflow-as-Code 编排监控。
Source 采集事实，Rule 判断阈值并生成消息，用户目录中的 Monitor 负责调用通知 Flow。

## 当前监控

| Monitor | 功能 |
| --- | --- |
| `u/oneke/monitors/aave_v3_hf_alert` | Aave V3 用户仓位 HF |
| `u/oneke/monitors/aave_v3_market_risk` | Aave V3 Reserve 流动性、APY 和供借量 |
| `u/oneke/monitors/aave_v4_hf_alert` | Aave V4 用户 Spoke 账户 HF |
| `u/oneke/monitors/morpho_hf_alert` | Morpho 借款仓位 HF |
| `u/oneke/monitors/binance_vip_hf_alert` | Binance VIP Loan HF，按 collateralAccountId 配置阈值 |
| `u/oneke/monitors/okx_loan_hf_alert` | OKX Flexible Loan HF |
| `u/oneke/monitors/hyperliquid_liquidation_risk` | Hyperliquid 全仓／逐仓清算距离和保证金池风险（每分钟） |
| `u/oneke/monitors/aave_v4_configuration_change` | Aave V4 配置快照变更 |

HF Rule 返回 `{level, title, description}` 或 `null`，Monitor 仅通知非空结果。
HF 持续低于阈值时，每次定时运行都会告警。各 Monitor 的 `.schedule.yaml` 定义周期和参数。

协议接口、输入与阈值配置见 [Aave](f/aave/README.md)、[Morpho](f/morpho/README.md)、
[Binance](f/binance/README.md) 和 [OKX](f/okx/README.md)。

[Hyperliquid](f/hyperliquid/README.md) 提供账户全部永续仓位 Source 与清算风险 Rule，
覆盖全仓、逐仓和 HIP-3 DEX；Monitor 将触线及无法判断的结果交给现有通知渠道。

## 配置变更与通知

X 账号帖子可通过 Webhook 直接转发到现有 Telegram 通知渠道。
接入与凭证配置见 [X Webhook](u/oneke/sources/X_WEBHOOK.md)。

Aave V4 配置 Source 位于 `u/oneke/sources/aave_v4_configuration`。
Monitor 先读取该 Source 最近成功 job，再采集当前快照；首次采集只建立历史。
已有历史时，通过 `f/chain_sentinel/rules/diff` 生成包含旧值的 JSON Patch，
并由 `renderJsonDiff` 分组渲染后发送通知。字段与采集边界见
[Aave V4 配置清单](f/aave/MARKET_PARAMS.md)。

`u/oneke/channels/notification` 将所有消息交给 Windmill Hub Telegram 集成，
error 消息同时调用 `f/chain_sentinel/scripts/destinations/send_flashduty`。
两个通知分支独立运行，投递失败会使 Flow 失败。用户连接配置保存在 `u/oneke/resources/`。

FlashDuty 使用根目录的 `c_flashduty.resource-type.yaml` 与
`c_alert_message.resource-type.yaml`，将 `critical`、`warning`、`info` severity
映射到 FlashDuty 标准告警事件。批量投递由 `lib/destination-batch.ts` 控制并发，单批最多 100 条。

## 项目结构

```text
f/
  aave/                  # V3/V4 Source、HF Rule、配置 Reader 和连接
  binance/               # VIP Loan Source 与 HF Rule
  okx/                   # Flexible Loan Source 与 HF Rule
  morpho/                # 仓位 Source 与 HF Rule
  handlebars/            # HF 告警模板渲染
  wmm/                   # Windmill job 历史读取
  chain_sentinel/
    lib/
      destination-batch.ts
      jsondiff.ts
      source-tm.ts
    rules/diff.ts
    sources/previous.ts
    scripts/destinations/send_flashduty.ts
u/oneke/
  monitors/              # Workflow-as-Code 与 Schedule
  sources/               # 配置采集 Flow
  channels/              # 通知 Flow 与渠道配置
  resources/             # 用户连接配置
c_*.resource-type.yaml    # 根目录的自定义 Resource Type
```

`lib` 中的 `.script.yaml` / `.script.lock` 是 Windmill 同步和依赖解析所需的伴随文件。
纯库通过相对 import 使用，不提供 `main` 入口。
GraphQL 查询类型通过 `bun run codegen` 生成，配置位于 `codegen.ts`。

## 本地验证

```bash
npm test
npm run check
```

这些命令不会部署。只读采集预览使用 `wmill script preview` 或 `wmill flow preview`。

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
