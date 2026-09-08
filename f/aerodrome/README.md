# veAERO 自动投票

入口：`f/aerodrome/auto_vote_optimizer`，摘要：多 NFT veAERO 自动投票优化。

只需填写钱包地址，流程会自动发现直接持有的 veAERO NFT、读取当周池子奖励和票数、估值并分配投票权。执行模式还会模拟、签名、广播、等待两次确认并核验链上投票。没有奖励领取、兑换或复投操作。

## 配置与运行

默认 RPC 为 `https://base-rpc.publicnode.com`，Base chain ID 为 8453。合约地址已内置，每次运行通过 `Voter.ve()` 和 `VotingEscrow.voter()` 双向校验。无需填写合约、ABI、selector、池子快照或 NFT ID。

只读运行参数：

```json
{
  "walletAddresses": ["你自己填写的 Base 地址"],
  "dryRun": true
}
```

`dryRun` 默认开启，既不读取签名密钥，也不写执行状态或广播交易。默认执行窗口以外返回投票计划并标记 `outside_execution_window`，不伪称模拟成功。需要在合法窗口内提前测试模拟时，可加 `options.executionLeadSeconds: 590000`；签名执行仍应使用默认的临近截止窗口。

无人值守执行使用 Windmill 加密 Secret Variable：在 Windmill 中自行创建密钥变量，并将地址映射到变量路径。输入和 Git 中只放路径，不能放密钥值，也不要用 `$var:` 展开密钥到输入。示例：

```json
{
  "walletAddresses": ["0x..."],
  "dryRun": false,
  "signerVariablePaths": {"0x...": "f/aerodrome/owner_signing_key"}
}
```

内置签名器支持直接持有 NFT 的 EOA；密钥推导地址必须等于 NFT owner，且钱包有足够 Base ETH。Safe、硬件钱包、Relay 管理人签名不在此执行器的支持范围内。私钥只在执行步骤内部读取，错误消息不会包含密钥。Windmill worker 和有权读取该 Secret 的管理员能够接触该密钥，所以它不是仅有投票权限的授权。

`auto_vote.schedule.yaml` 已提供每周三 UTC 21:00–22:50、每 10 分钟运行的调度（北京时间周四 05:00–06:50）。填好 `args`、完成 dry-run 验证后，将 `enabled` 改为 `true` 并将 `dryRun` 改为 `false`。默认关闭是因为通用仓库没有用户地址和签名配置。按项目现有 GitHub Actions 路径部署；本实现不会绕过 Git 推送直接同步生产。

调度使用 `no_flow_overlap`，Flow 声明全局并发上限 1。不要对同一钱包同时运行其他发送交易的程序或并行手动启动多个实例；社区版 Windmill 是否强制执行并发上限取决于其支持情况。执行器也检查 pending nonce，合约限制同一 NFT 当周重复投票。

## 数据与优化模型

- NFT：同一个区块读取 `balanceOf`、`ownerToNFTokenIdList`、`ownerOf`、`balanceOfNFT`、`escrowType`、`locked`、`lastVoted` 和旧投票。NFT ID、链上金额、投票 calldata 使用 BigInt/十进制字符串。
- 池子：从 `Voter.length/pools` 枚举所有登记池子，只使用存活 Gauge；读取各 Gauge 的手续费和激励奖励合约。
- 奖励：枚举奖励代币，读取 `tokenRewardsPerEpoch(token, currentEpoch)`，只计已经存入本周奖励合约的金额。尚未入账的手续费、未来激励、LP AERO emissions 和 rebase 不计入投票收益。
- 估值：通过 DefiLlama 公开价格 API，要求正价格、最多一小时偏差及至少 0.9 confidence；无有效价格或 decimals 的奖励计为未知并返回在 `unpriced` 中，不当作零风险资产。估值是参考美元价值，尚未模拟奖励卖出滑点。
- 固定与可动票：已投 NFT 作为固定仓位；可投 NFT 的旧票从池子当前分母中移除，再加入新分配，避免重复计算自己的票。

连续分配最大化 `Σ R × (f + x) / (b + f + x)`：`R` 为折扣后的奖励价值，`f` 为自己的固定票，`b` 为其他票，`x` 为本次新增票。默认将其他票乘 1.15，奖励乘 0.9；这些是可配置保守假设，不是训练出的预测。

每池边际收益随追加票数递减。分别计算贪心增加池子和全池连续解筛选后的方案，保留预期收益较高者；有池子数量约束时是启发式算法，不保证全局最优。多 NFT 按同一组合比例分配，估计收益按实际整数权重重新计算。可用 `maxPools`（默认 10）和 `maxShare`（默认 1）限制集中度。

默认只在普通投票截止前两小时至前十分钟发送交易。每次执行再检查区块时间、epoch、归属、NFT 类型、投票权和是否已投；交易模拟覆盖 Gauge 状态和合约限制。Gas 门槛包含 L2 费用以及 Base GasPriceOracle 的 L1/operator 费用保守预估，默认每个 NFT 上限 2 美元、净收益下限 0 美元。费用和净收益均是预估，不是成交保证。

## 状态与恢复

执行日志保存在 `f/aerodrome/__vote_state`（已排除 Git 同步），键为 `epoch:tokenId`。日志在广播前记录签名交易 hash 和 nonce，不保存私钥或原始签名交易。

广播超时或进程崩溃后，重跑优先查询已记录 hash；成功交易不会再次发送。无法确认 hash 时会停止并报告 hash/nonce，包括“签名后、广播前崩溃”的情况，需要管理员核对链上 nonce 和交易再处理该条日志；不会盲目签署新交易。已上链失败交易允许重新模拟后重试。确认后的结果还检查 `lastVoted` 和池子票数。

Relay/managed NFT、零投票权及本周已投 NFT 会明确标记跳过。直接持有的永久锁仓是本任务的目标；托管在其他协议中的 NFT 无法通过原钱包持有人枚举发现。

## 验证

```sh
npm test
wmill lint f/aerodrome --fail-on-warn --locks-required
wmill flow preview f/aerodrome/auto_vote_optimizer__flow --workspace <隔离测试 workspace> -d '<只读参数 JSON>'
```

本地集成测试会在 Anvil fork 上给临时账户创建两个永久锁仓 NFT，使用真实 Aerodrome 合约完成模拟、签名、广播、确认及重复运行检查。测试只允许 localhost Anvil，所有资产和交易均为 fork 状态：

```sh
anvil --fork-url https://mainnet.base.org --chain-id 8453 --port 18545 --silent
bun tests/aerodrome-fork.ts
```

可给测试脚本追加同一 epoch 的已保存公开 Snapshot JSON 路径，以复用市场数据。测试推进 fork 时间到投票窗口，不会推进主网时间。

来源：[官方部署清单](https://github.com/aerodrome-finance/contracts#deployment)、[Voter](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Voter.sol)、[Reward](https://github.com/aerodrome-finance/contracts/blob/main/contracts/rewards/Reward.sol)、[价格 API](https://coins.llama.fi)。
