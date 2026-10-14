# Aave V4 deployless config reader

`src/AaveV4ConfigReader.sol` 聚合协议公开 getter，以独立 Solidity struct 返回：

- `readHub(address)` 返回 Hub、所有资产/注册 Spoke 关系、借贷 Spoke、Treasury、TokenizationSpoke、未知 Spoke 的代码哈希，以及关联 Authority。
- `readSpoke(address)` 返回 Oracle、清算、reserve 全部动态配置版本，以及通过 `extSloads` 读取的 ERC-1967 配置。
- `readAuthority(address)` 枚举角色、成员和目标权限，显式读取 ADMIN/PUBLIC 特殊角色。Hub 聚合还补齐已知函数的默认 ADMIN 权限，并通过官方角色命名空间发现 Configurator 的 Authority。

所有注册 Spoke 都保留 cap 和状态；类型按 `ORACLE`、`owner/pendingOwner`、`hub` 等公开接口识别，不能按 `SPOKE_REVISION` 区分，因为官方实现共用这个名称。
未知类型只保留注册关系与代码哈希。成员列表不枚举 PUBLIC；非 enumerable Authority 只保留已知 Hub/Spoke 函数权限，不伪造空角色列表。
Getter、ABI 解码、非空接口探测错误、枚举超限均失败。空 revert 被视为接口不存在；因此无法识别任意自定义合约用空 revert 隐藏的故障。探测限定 30,000 gas；枚举集合限定 10,000 项。

配置说明见 [Aave V4 协议配置](../../f/aave/MARKET_PARAMS.md)。接口依据 [Aave V4 官方合约](https://github.com/aave/aave-v4/tree/main/src)。

## 调用边界

`f/aave/lib/multicall.ts` 的 `rpcMulticall(rpcUrl, params)` 接收 viem multicall 参数，按 ABI、顺序和 `allowFailure` 推导结果类型；支持指定区块、state override、批次大小和 deployless。空批次不发请求。

监控 Source 每个网络调用一次已有 Multicall3，以 `latest` 逐个执行 `readHub`，Reader runtime bytecode 注入虚拟地址 `0x000000000000000000000000000000000000a004`。`batchSize=0`、`allowFailure=false`，不拆批或 fallback。
Reader 无 storage 或 immutable 依赖，无需部署。RPC 必须支持 state override 且存在 canonical Multicall3。
`read_hubs` 输出为 `NetworkParams`（`hub_address → HubGraph`），Workflow 并行读取网络并聚合成 `chain_id → NetworkParams`。不进行对象重组或地址规范化；仅把 bigint 序列化为十进制字符串。creation-based deployless multicall 会因大返回值遇到 EIP-170 限制，不用于完整对象图。

Spoke `extSloads` 允许读取标准 ERC-1967 槽；Hub/Treasury/Tokenization 未暴露该 getter，无法用 Reader 获取其代理 implementation。代码哈希通过 EVM `EXTCODEHASH` 读取；代理壳代码不变时，仅代码哈希不能发现升级。
不枚举 position manager、API 未索引 Hub、自定义控制器/价格适配器内部配置，也不递归扩展 reserve 引用的其他 Hub。

## 构建与验证

需要 Foundry（`forge` 和 `anvil`）。Solidity 0.8.28、Paris、优化器和 via-IR 固定在 `foundry.toml`；产物保存在系统临时目录。

```sh
node scripts/build-aave-reader.mjs
forge test --root contracts/aave-v4 --out /tmp/chainbot-aave-reader-out --cache-path /tmp/chainbot-aave-reader-cache
node scripts/build-aave-reader.mjs --check
AAVE_READER_INTEGRATION=1 bun run test
bun run check
```

生成文件包含 typed ABI、creation bytecode 和 runtime bytecode；`--check` 核对可重复构建。
Foundry 验证对象图、标准接口分类、历史配置、权限、代理和失败边界。
Anvil 验证 Source 多 Hub 一个 `eth_call`、latest 更新、state override、Reader 原始结构、读取→Rule 与单 Hub 失败传播；独立 RPC 工具仍验证指定区块读取，测试交易仅发送临时本地 EVM。正常测试跳过 Foundry 依赖的集成测试。
