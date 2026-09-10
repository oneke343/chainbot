# veAERO 自动投票

入口：`f/aerodrome/auto_vote_optimizer`，摘要：多 NFT veAERO 自动投票优化。

Flow 现在拆成三个可单独观察的阶段：`collect` 发现 NFT 并读取固定区块快照，`optimize` 预筛候选池并计算合计票权分配，`execute` 模拟、签名、广播、确认并核验链上投票。每个阶段返回 `stage`、`elapsedMs` 和阶段指标，Windmill job step 也会单独记录耗时和结果。没有奖励领取、兑换或复投操作。

## 配置与运行

默认 RPC 为 `https://base-rpc.publicnode.com`，Base chain ID 为 8453。NFT 数据来自官方 Base Sugar 合约；池子、奖励和 token decimals 均由已部署的 `AerodromePoolView` 分页返回，每页默认扫描 100 个 Voter 索引。普通 collect 阶段默认每个 Multicall 包含 1000 个读取并发执行 4 个请求；价格 API 也按 100 个 token 分批并发执行 4 个请求。可用 `rpcChunkSize`（100–1000）和 `rpcConcurrency`（1–8）按 RPC 服务商调节。公共 RPC 若出现请求体过大或限流，可将两项调低。

Sugar 地址以官方仓库的 Base deployment 清单为准，而不是从官网前端 bundle 猜地址。不同发布版本可能使用不同的 Sugar 实例；运行时指针校验会在读取前发现这类版本漂移，并让流程失败，而不是混用不兼容的返回结构。

实现上，`lib/sugar.ts` 只负责 Sugar ABI 和原始数据读取，`lib/pool_view.ts` 负责分页 view 合约读取，`lib/rpc.ts` 负责 Multicall、分块和并发；`lib/snapshot.ts` 负责固定区块快照和奖励估值，`lib/optimizer.ts` 是不依赖链上执行的纯优化核心，`lib/execution.ts` 负责模拟、签名、广播、journal 和结果确认；`lib/vote.ts` 只保留兼容旧调用方的公共 facade。
池子发现不调用 `LpSugar.count/all`，因此不会扫描 Sugar 的全量历史池索引；`AerodromePoolView.activePoolsWithRewards` 直接按 Voter 当前活跃 Gauge 聚合 `weights`、epoch 奖励和 token decimals。

`collect_snapshot` 的 `metrics` 现在会报告 `deploymentValidationMs`、`sugarValidationMs`、`nftDiscoveryMs`、`poolDiscoveryMs`，以及 `steps` 下的 `sugarNftMs`、`sugarPoolMs` 和奖励估值耗时。NFT 与池子 discovery 是并行的，因此两者的耗时不能直接相加；先比较两者的较大值，再查看对应 `steps` 项。NFT 读取只使用 `VeSugar.byAccount`；如果 RPC 拒绝该聚合调用，流程直接失败，请更换 RPC 或调整服务商限制。

执行阶段会把所有待执行 NFT 的归属、最后投票 epoch 和 voting power 预检查合并到一次固定区块 Multicall。dry-run 只模拟交易；真正广播时只读取交易所需的 gas limit 和 EIP-1559 fee 参数，不将 gas 成本纳入池子选择、最低收益或跳过条件。

Flow 输入中的执行参数统一放在 `execution` 对象：`dryRun`、`voteExecutor`、`adminAddress`、`adminVariablePath` 和 `executorBatchSize`。`options` 仍是优化和候选池筛选参数，`rpcUrl`、`rpcChunkSize`、`rpcConcurrency` 和 `walletAddresses` 保持在顶层。

只读运行参数：

```json
{
  "walletAddresses": ["你自己填写的 Base 地址"],
  "execution": {
    "dryRun": true,
    "voteExecutor": "0x执行器地址",
    "adminAddress": "0xadmin地址",
    "adminVariablePath": "f/aerodrome/vote_admin_key",
    "executorBatchSize": 16
  }
}
```

`execution.dryRun` 默认开启且不会广播交易。每个 batch 会先用 `eth_simulateV1` 模拟交易意图，检查成功后用 `eth_fillTransaction` 补齐 nonce、gas、fee 和 chainId，再校验 filled transaction；配置 `adminVariablePath` 时继续本地签名，dry-run 在签名后停止。执行结果会记录 simulation 返回的 `gasUsed` 和 filled transaction 的 `gasLimit`，并在 Windmill job 日志中打印。代码不再自行检查 Base 的固定 gas limit，最终限制由 simulation、fill 或实际广播阶段返回的节点错误决定。正式执行使用同一个 filled transaction 签名后发送，并保留 journal、广播和 receipt 处理。只有当前区块时间严格位于快照的 `voteStart` 和 `voteEnd` 之间，才会执行交易模拟；窗口外返回 `outside_voting_window`，不伪称模拟成功。

无人值守执行统一使用最小权限 `VoteExecutor`：在 Base 部署本仓库的 `contracts/aerodrome/VoteExecutor.sol`，构造参数只填写 admin 地址；然后由 NFT owner 在 `VotingEscrow` 上对每个 tokenId 单独执行 `approve(executor, tokenId)`。owner 的私钥不进入 Windmill，Windmill 只保存 admin 的加密 Secret Variable。执行器没有 fallback、任意 call 或升级入口，只能通过 `voteMany` 将固定格式的投票转发到固定的 Aerodrome Voter。admin 还可以轮换 admin 权限并恢复误转入执行器的 ERC20/ETH；admin 私钥泄漏时，攻击者能影响投票和执行器内已有资产，因此应使用专用 admin 地址。

`transferAdmin(newAdmin)` 只能由当前 admin 调用；`recoverERC20(token, to, amount)` 和 `recoverETH(to, amount)` 也只有 admin 可调用。执行器不会自动接收奖励，veAERO NFT 仍由 owner 持有。

推荐模式的输入示例（`voteMany` 默认每批 16 个 NFT）：

```json
{
  "walletAddresses": ["0x..."],
  "execution": {
    "dryRun": false,
    "voteExecutor": "0x执行器地址",
    "adminAddress": "0xadmin地址",
    "adminVariablePath": "f/aerodrome/vote_admin_key",
    "executorBatchSize": 16
  }
}
```

`adminAddress` 必须等于 Secret Variable 私钥推导出的地址；dry-run 也要填写它，便于用正确的 `msg.sender` 模拟 wrapper。执行器会按 `executorBatchSize` 将多个 NFT 合并到原子 `voteMany` 交易；任一 NFT 模拟或链上投票失败，整批回退。默认值为 16；如果单批 calldata 过大，可主动调低。停用执行器时，owner 可在 VotingEscrow 对对应 tokenId 执行 `approve(0, tokenId)`。授权执行器仍是一次性的协议操作授权，因此部署前应核对源码和地址；执行器可以接收 ETH，admin 可通过 `recoverETH` 提取。
`auto_vote.schedule.yaml` 配置为每周三 UTC 22:59 运行，即协议 `voteEnd` 前约 1 分钟（北京时间周四 06:59）。填好 `args.execution`、完成 dry-run 验证后，将 `enabled` 改为 `true` 并将 `args.execution.dryRun` 改为 `false`。默认关闭是因为通用仓库没有用户地址和签名配置。按项目现有 GitHub Actions 路径部署；本实现不会绕过 Git 推送直接同步生产。

调度使用 `no_flow_overlap`，Flow 声明全局并发上限 1。不要对同一钱包同时运行其他发送交易的程序或并行手动启动多个实例；社区版 Windmill 是否强制执行并发上限取决于其支持情况。执行器也检查 pending nonce，合约限制同一 NFT 当周重复投票。

## 数据与优化模型

- NFT：同一个区块读取 `VeSugar.byAccount` 返回的 ID、owner、投票权、上次投票和旧投票。NFT ID、链上金额、投票 calldata 使用 BigInt/十进制字符串。
- 池子：从 `Voter.length/pools/gauges/isAlive` 枚举当前投票目录，只保留活跃 Gauge；票数和奖励地址用同一固定区块读取。
- 奖励：由 `AerodromePoolView.activePoolsWithRewards` 返回当前 epoch 的手续费、激励和 token decimals，再按 token 价格估值。尚未入账的手续费、未来激励、LP AERO emissions 和 rebase 不计入投票收益。
- 估值：通过 DefiLlama 公开价格 API，要求正价格、最多一小时偏差及至少 0.9 confidence；无有效价格或 decimals 的奖励计为未知并返回在 `unpriced` 中，不当作零风险资产。估值是参考美元价值，尚未模拟奖励卖出滑点。
- 固定与可动票：已投 NFT 作为固定仓位；可投 NFT 的旧票从池子当前分母中移除，再加入新分配，避免重复计算自己的票。

连续分配最大化 `Σ R × (f + x) / (b + f + x)`：`R` 为折扣后的奖励价值，`f` 为自己的固定票，`b` 为其他票，`x` 为本次新增票。默认将其他票乘 1.15，奖励乘 0.9；这些是可配置保守假设，不是训练出的预测。

每池边际收益随追加票数递减。分别计算贪心增加池子和全池连续解筛选后的方案，保留预期收益较高者；有池子数量约束时是启发式算法，不保证全局最优。多 NFT 按同一组合比例分配，估计收益按实际整数权重重新计算。单次最多选择的池子数量直接使用同一快照中的 Voter `maxVotingNum`；可用 `maxShare`（默认 1）限制集中度，并用 `minSelectedShare`（默认 0.5%）清理最终分配过小的噪音池后重新优化。

### optimize_votes 的投票计算

`optimize_votes` 接收 `collect_snapshot` 的完整快照，不重新读取链上数据。它先把所有 `eligible` NFT 的 `power` 相加，得到本次可移动的总投票权 `total`。因此池子选择基于所有 NFT 的合计 power，不会先用某个小 NFT 选择池子，再把结果复制给大 NFT。

对每个有价格奖励的池子，代码从 `p.votes` 中减去所有本地 NFT 的旧票：可移动 NFT 的旧票会被下一次 `Voter.vote` 重置，不能再次算进竞争分母；不可移动 NFT 的旧票保留为 `fixed`。剩余票数乘 `dilution` 形成保守的外部票 `b`，当前 epoch 奖励乘 `1 - rewardHaircut` 形成奖励价值 `r`。

候选预筛使用两个可选阈值：`candidateMinVotes` 是扣除可移动本地旧票后的有效竞争票数下限，`candidateMinRewardPerVoteUsd` 是奖励除以风险调整后的外部及固定票数后的最低收益密度。只有池子同时满足“有效竞争票少”和“收益密度低”时才会被过滤，因此低票高收益密度池不会被误删。筛选后如果池子数量不足以满足 `ceil(1 / maxShare)`，代码会从原候选集中按内部潜在收益上界回填，避免集中度约束变成不可执行。候选池不会再按固定数量截断。

对保留下来的池子，`solve` 最大化：

```text
reward(p) × (fixed(p) + x(p))
           -----------------------------
           external(p) + fixed(p) + x(p)
```

其中 `x(p)` 是全部 eligible NFT 合计新增到池子 `p` 的票。每个池子的边际收益会递减，所以代码通过 180 次二分搜索寻找共同边际收益阈值；无池子数量约束的结果称为 relaxed solution，再和逐个加入池子的 greedy solution 比较，选择总收益较高者。

求出合计 `x(p)` 后，代码把它转换成 `1e12` 精度的相对权重。例如 `600000000000` 和 `400000000000` 表示 60/40，而不是 6000 和 4000 个 veAERO。每个 NFT 的 voteMany 参数都使用这组相对权重。Aerodrome Voter 会按该 NFT 自己的 `balanceOfNFT` 计算实际池子票数，因此 power 为 1 和 power 为 99 的 NFT 会分别贡献 1% 和 99% 的合计分配。代码还检查整数舍入后每个 NFT 对每个选中池子仍有正票，避免小 NFT 静默丢失某个池子的票。

`optimize_votes` 返回的 `allocations` 只是 tokenId、池子、相对权重和收益估计组成的投票计划。它不签名、不广播，也不读取私钥；这些动作只在 `execute_votes` 阶段发生。执行阶段只接收区块、epoch 和投票起止时间等执行元数据，并用同一 epoch 的新状态重新组装 `voteMany` calldata，模拟并核验 NFT 归属、投票权和投票窗口。`execute_votes` 的 `execution` 返回值按批次列出 `batches`，每个批次包含 filled transaction 的 `chainId`、`nonce`、gas/fee 字段、`estimatedGas`、`gasLimit` 以及 `simulation` 或 `broadcast` 结果；`skipped` 单独记录每个 NFT 的跳过原因。dry-run 的 `signedHash` 仅表示本地签名结果，不代表已经上链。

候选池预筛默认关闭（两个 `candidate*` 参数均为 0），因此默认行为不会因候选阈值改变。需要缩小候选噪音时，可在 `options` 中配置 `candidateMinVotes` 和 `candidateMinRewardPerVoteUsd`；二者同时启用时，仅过滤低票且低收益密度的池子。`excludedPools` 可用于手动排除已知异常或不希望投票的池子，这些池子不会进入候选集合，也不会被 fallback 重新加入。内部 `maxGain` 仍用于 fallback 排序和组合优化，但不再作为用户可配置的预筛阈值。候选预筛之后，最终结果还会按 `minSelectedShare`（默认 0.005，即 0.5%）删除低分配池并重新求解；设置为 0 时关闭经济阈值，但仍会删除低于 `1e-12` 相对权重精度的池子。预筛会自动保留足够满足 `maxShare` 的池子；阈值过严不会让约束失效，而是按内部潜在收益上界回填。建议先观察 `optimize.metrics`，再逐步提高阈值。

Gas 不参与池子选择和投票权分配模型。交易可以在快照记录的 `voteStart` 与 `voteEnd` 之间发送。每次执行再检查区块时间、归属、投票权和是否已投；NFT 类型由输入假设为普通 veNFT，交易模拟仍覆盖 Gauge 状态和合约限制。

## 状态与恢复

执行日志保存在 `f/aerodrome/__vote_state`（已排除 Git 同步），键为 `epoch:tokenId`。日志在广播前记录签名交易 hash 和 nonce，不保存私钥或原始签名交易。

广播超时或进程崩溃后，重跑优先查询已记录 hash；成功交易不会再次发送。无法确认 hash 时会停止并报告 hash/nonce，包括“签名后、广播前崩溃”的情况，需要管理员核对链上 nonce 和交易再处理该条日志；不会盲目签署新交易。已上链失败交易允许重新模拟后重试。确认结果以交易 receipt 成功为准；执行前仍会检查 NFT 归属、投票权、重复投票状态和投票窗口。

零投票权及本周已投 NFT 会明确标记跳过。当前输入假设 NFT 是直接持有的普通永久锁仓；Relay、locked 或 managed NFT 不做额外类型读取，若传入这类 NFT，投票模拟或交易会按协议规则失败。

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

可给测试脚本追加同一 epoch 的已保存公开 Snapshot JSON 路径，以复用市场数据；不追加 Snapshot 时需设置已部署的 `AERODROME_POOL_VIEW`。测试只在 fork 中推进时间，不会推进主网时间。

来源：[官方部署清单](https://github.com/aerodrome-finance/contracts#deployment)、[Voter](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Voter.sol)、[Reward](https://github.com/aerodrome-finance/contracts/blob/main/contracts/rewards/Reward.sol)、[价格 API](https://coins.llama.fi)。
