# veAERO 自动投票

入口：`f/aerodrome/auto_vote_optimizer`，摘要：多 NFT veAERO 自动投票优化。

Flow 现在拆成三个可单独观察的阶段：`collect` 发现 NFT 并读取固定区块快照，`optimize` 预筛候选池并计算合计票权分配，`execute` 模拟、签名、广播、确认并核验链上投票。每个阶段返回 `stage`、`elapsedMs` 和阶段指标，Windmill job step 也会单独记录耗时和结果。没有奖励领取、兑换或复投操作。

## 配置与运行

默认 RPC 为 `https://base-rpc.publicnode.com`，Base chain ID 为 8453。合约地址已内置，每次运行通过 `Voter.ve()` 和 `VotingEscrow.voter()` 双向校验。无需填写合约、ABI、selector、池子快照或 NFT ID。collect 阶段默认每个 Multicall 包含 1000 个读取并发执行 4 个请求；可用 `rpcChunkSize`（100–1000）和 `rpcConcurrency`（1–8）按 RPC 服务商调节。公共 RPC 若出现请求体过大或限流，可将两项调低。

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

### optimize_votes 的投票计算

`optimize_votes` 接收 `collect_snapshot` 的完整快照，不重新读取链上数据。它先把所有 `eligible` NFT 的 `power` 相加，得到本次可移动的总投票权 `total`。因此池子选择基于所有 NFT 的合计 power，不会先用某个小 NFT 选择池子，再把结果复制给大 NFT。

对每个有价格奖励的池子，代码从 `p.votes` 中减去所有本地 NFT 的旧票：可移动 NFT 的旧票会被下一次 `Voter.vote` 重置，不能再次算进竞争分母；不可移动 NFT 的旧票保留为 `fixed`。剩余票数乘 `dilution` 形成保守的外部票 `b`，当前 epoch 奖励乘 `1 - rewardHaircut` 形成奖励价值 `r`。

候选预筛使用三个可选阈值。`candidateMinRewardUsd` 过滤奖励尘埃；`candidateMinRewardPerVoteUsd` 过滤奖励密度过低的池子；`candidateMinExpectedGainUsd` 使用“最多投入本次总 power 后的理论增量收益”过滤潜力仍不足的池子。`candidatePoolLimit` 按该理论增量收益排序截断。筛选后如果池子数量不足以满足 `ceil(1 / maxShare)`，代码会从原候选集中按潜在收益回填，避免集中度约束变成不可执行。

对保留下来的池子，`solve` 最大化：

```text
reward(p) × (fixed(p) + x(p))
           -----------------------------
           external(p) + fixed(p) + x(p)
```

其中 `x(p)` 是全部 eligible NFT 合计新增到池子 `p` 的票。每个池子的边际收益会递减，所以代码通过 180 次二分搜索寻找共同边际收益阈值；无池子数量约束的结果称为 relaxed solution，再和逐个加入池子的 greedy solution 比较，选择总收益较高者。

求出合计 `x(p)` 后，代码把它转换成 `1e12` 精度的相对权重。例如 `600000000000` 和 `400000000000` 表示 60/40，而不是 6000 和 4000 个 veAERO。每个 NFT 的 `vote(tokenId, pools, weights)` 都使用这组相对权重。Aerodrome Voter 会按该 NFT 自己的 `balanceOfNFT` 计算实际池子票数，因此 power 为 1 和 power 为 99 的 NFT 会分别贡献 1% 和 99% 的合计分配。代码还检查整数舍入后每个 NFT 对每个选中池子仍有正票，避免小 NFT 静默丢失某个池子的票。

`optimize_votes` 返回的 `allocations` 只是投票计划和 calldata。它不签名、不广播，也不读取私钥；这些动作只在 `execute_votes` 阶段发生。执行阶段会用同一 epoch 的新状态重新模拟并核验 NFT 归属、投票权和窗口。

候选池预筛默认关闭（四个 `candidate*` 参数均为 0），因此默认行为不会因阈值改变。需要缩小噪音池时，可在 `options` 中配置：`candidateMinRewardUsd` 是本周最低美元奖励，`candidateMinRewardPerVoteUsd` 是奖励除以当前外部加固定票数的最低密度，`candidateMinExpectedGainUsd` 是在本次总投票权和 `maxShare` 上限下的最低潜在增量收益，`candidatePoolLimit` 是预筛后最多保留的池子数量。预筛会自动保留足够满足 `maxShare` 的池子；阈值过严不会让约束失效，而是按潜在增量收益回填。建议先观察 `optimize.metrics`，再逐步提高阈值。低票高奖励池不会因为票少被默认删除。

Gas 不参与池子选择和投票权分配模型。执行阶段仍保留 Gas 上限和最低净收益检查，作为异常费用保护；Base Gas 正常时不会改变优化结果。默认只在普通投票截止前两小时至前十分钟发送交易。每次执行再检查区块时间、epoch、归属、NFT 类型、投票权和是否已投；交易模拟覆盖 Gauge 状态和合约限制。费用和净收益均是预估，不是成交保证。

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
