# Aave V4 协议配置

Aave V4 的配置围绕 Hub、Hub 资产、Spoke 和 reserve 组织。
Hub 管理共享资产与流动性；借贷 Spoke 在这些资产之上定义市场、抵押规则和清算规则。
一个 Hub 可以有多个资产，一个借贷 Spoke 可以有多个 reserve；reserve 通过
`(hub, assetId)` 引用 Hub 资产。

## 实体及关系

```text
网络
├── Hub
│   ├── authority → 权限管理合约
│   └── assets[assetId]
│       ├── 资产配置
│       ├── irStrategy → 利率策略及该资产的曲线
│       ├── feeReceiver → 收费 Spoke / Treasury
│       ├── reinvestmentController → 再投资控制器
│       └── registeredSpokes[spokeAddress]
│           └── 该 Spoke 对该资产的额度与操作权限
├── 借贷 Spoke
│   ├── authority → 权限管理合约
│   ├── Oracle → reserve 的价格源
│   ├── 清算配置
│   ├── positionManagers[managerAddress]
│   └── reserves[reserveId]
│       ├── hubAsset → (Hub 地址, assetId)
│       ├── reserve 配置
│       └── dynamicConfigs[dynamicConfigKey]
├── Authority
│   ├── roles[roleId] → 角色设置与成员
│   └── targets[targetAddress] → 目标设置与函数权限
├── Treasury → owner、pendingOwner
├── TokenizationSpoke → hub、assetId、underlying、decimals
└── 合约部署信息 → 代码、implementation、admin、beacon
```

Hub 注册的 Spoke 不一定是借贷 Spoke，也可能承担收费、代币化或其他职能。
额度属于 **Hub 资产与注册 Spoke 的关系**，而不是整个 Hub 或 reserve 的独立全局参数。
共享 Hub 资产、Authority 和合约通过身份引用关联，不能把它们当作每个 reserve 的独立副本。

## 单位

| 表示 | 含义 | 示例 |
|---|---|---|
| BPS | 基点，`10000 = 100%` | `8000 = 80%` |
| WAD | 以 `10^18` 缩放的定点数 | `10^18` 表示健康因子 1 |
| 整枚资产 | 未乘以 token decimals 的数量 | cap `100` 表示 100 枚 |
| 秒 | 持续时间 | delay `3600` 表示 1 小时 |
| Unix 时间戳 | 时间点 | 成员权限生效时间、待变更延迟生效时间 |

不要把整枚 cap 与最小代币单位金额直接比较。例如 USDC 精度为 6，cap `100`
对应 `100 × 10^6` 最小单位。动态余额、实时价格、当前利用率与当前借款利率属于
协议状态，不是这里列出的治理配置。

## Hub 与资产

Hub 的 `authority()` 指定管理该 Hub 的权限合约。
资产以 `(Hub 地址, assetId)` 标识；`assetId` 只在所属 Hub 内有意义。

| 字段 | 类型 / 单位 | 含义 | 接口 |
|---|---|---|---|
| `underlying` | address | 底层 token 身份 | `getAssetUnderlyingAndDecimals` |
| `decimals` | uint8 | 资产精度 | 同上 |
| `feeReceiver` | address | 接收协议费用份额的 Spoke | `getAssetConfig` |
| `liquidityFee` | uint16 / BPS | drawn 与 premium 利息增长的协议费用比例 | 同上 |
| `irStrategy` | address | 为该资产提供利率曲线的策略合约 | 同上 |
| `reinvestmentController` | address | 闲置流动性再投资控制器；零地址表示未配置 | 同上 |

这些字段属于共享 Hub 资产。同一个 Hub 资产被多个借贷 Spoke 使用时，共享其利率策略和费用设置。
参见 [IHub](https://github.com/aave/aave-v4/blob/main/src/hub/interfaces/IHub.sol)。

### 资产的利率曲线

官方利率策略通过 `getInterestRateData(assetId)` 给出该资产的曲线参数。

| 字段 | 类型 / 单位 | 含义 |
|---|---|---|
| `optimalUsageRatio` | uint16 / BPS | 利用率拐点 |
| `baseDrawnRate` | uint32 / BPS | 基础借款利率 |
| `rateGrowthBeforeOptimal` | uint32 / BPS | 达到拐点前的利率增长幅度 |
| `rateGrowthAfterOptimal` | uint32 / BPS | 拐点到满利用率的额外增长幅度 |

策略地址与曲线参数是不同的配置：地址不变时，曲线仍可改变。
当前实际借款利率随利用率计算，不等于这些固定曲线参数。
自定义策略的内部参数由其自身接口定义。
参见 [IAssetInterestRateStrategy](https://github.com/aave/aave-v4/blob/main/src/hub/interfaces/IAssetInterestRateStrategy.sol)。

### 资产与注册 Spoke 的关系

每条关系以 `(Hub 地址, assetId, Spoke 地址)` 标识，由 `getSpokeConfig` 返回。

| 字段 | 类型 / 单位 | 含义 |
|---|---|---|
| `addCap` | uint40 / 整枚资产 | 该 Spoke 对该资产的存入额度上限 |
| `drawCap` | uint40 / 整枚资产 | 该 Spoke 对该资产的借出额度上限 |
| `riskPremiumThreshold` | uint24 / BPS | premium shares 与 drawn shares 比值上限 |
| `active` | bool | 是否允许该 Spoke 操作该 Hub 资产 |
| `halted` | bool | 是否禁止立即改变流动性的操作 |

`addCap` / `drawCap` 为 `0` 时阻止新增对应额度，不表示无限。
`MAX_ALLOWED_SPOKE_CAP = 2^40 - 1` 表示无限额度；
`MAX_RISK_PREMIUM_THRESHOLD = 2^24 - 1` 表示不设 premium 比例阈值。
API 名称 `supplyCap` / `borrowCap` 对应合约的 `addCap` / `drawCap`，但须确认 API 金额使用的单位。
参见 [IHub 的 SpokeConfig](https://github.com/aave/aave-v4/blob/main/src/hub/interfaces/IHub.sol)
与 [Hub 常量](https://github.com/aave/aave-v4/blob/main/src/hub/Hub.sol)。

## 借贷 Spoke

Spoke 配置控制该市场的权限依赖、Oracle、清算逻辑和用户 reserve 数量限制。

| 字段 | 类型 | 含义 | 接口 |
|---|---|---|---|
| `authority` | address | 管理 Spoke 的权限合约 | `authority()` |
| `oracle` | address | 该 Spoke 使用的 Oracle | `ORACLE()` |
| `maxUserReservesLimit` | uint16 | 单用户允许的抵押 / 借款 reserve 数量上限，分别计数 | `MAX_USER_RESERVES_LIMIT()` |
| `liquidationLogic` | address | 清算逻辑库地址 | `getLiquidationLogic()` |

Oracle 和数量限制属于 implementation 的部署设置，升级 implementation 可能改变这些值。
参见 [Spoke](https://github.com/aave/aave-v4/blob/main/src/spoke/Spoke.sol)。

### Spoke 清算规则

`getLiquidationConfig()` 返回 Spoke 级别配置，对该市场的 reserves 共同生效。

| 字段 | 类型 / 单位 | 含义 |
|---|---|---|
| `targetHealthFactor` | uint128 / WAD | 清算期望恢复到的健康因子 |
| `healthFactorForMaxBonus` | uint64 / WAD | 达到最大清算奖励的健康因子阈值 |
| `liquidationBonusFactor` | uint16 / BPS | 接近 HF=1 时，奖励相对最大额外奖励的比例 |

例如 `targetHealthFactor = 1050000000000000000` 表示目标 HF 为 1.05。
最大清算奖励由被清算抵押 reserve 的动态配置决定，Spoke 的这三个字段控制
清算目标和奖励随健康因子变化的规则。
参见 [ISpoke 的 LiquidationConfig](https://github.com/aave/aave-v4/blob/main/src/spoke/interfaces/ISpoke.sol)
与 [LiquidationLogic](https://github.com/aave/aave-v4/blob/main/src/spoke/libraries/LiquidationLogic.sol)。

### Reserve 与 Hub 资产引用

reserve 以 `(Spoke 地址, reserveId)` 标识。`getReserve()` 给出资产身份与当前动态配置 key，
`getReserveConfig()` 给出操作开关和抵押风险系数。

| 字段 | 类型 / 单位 | 含义 |
|---|---|---|
| `hub`, `assetId` | address, uint16 | 引用的共享 Hub 资产 |
| `underlying`, `decimals` | address, uint8 | reserve 的 token 身份与精度 |
| `collateralRisk` | uint24 / BPS | 抵押品风险系数，参与用户风险溢价计算 |
| `paused` | bool | 暂停 reserve 操作 |
| `frozen` | bool | 阻止新增活动 |
| `borrowable` | bool | 是否允许借入 |
| `receiveSharesEnabled` | bool | 清算人是否可以接收抵押品份额 |
| `dynamicConfigKey` | uint32 | 最新动态抵押配置版本 |
| `priceSource` | address | Oracle 为该 reserve 配置的价格源 |

`priceSource` 来自 `Oracle.getReserveSource(reserveId)`。
`getReserve()` 中的 `flags` 是这些操作开关的编码表示，不是额外的一组独立配置。
参见 [ISpoke](https://github.com/aave/aave-v4/blob/main/src/spoke/interfaces/ISpoke.sol)。

### Reserve 的动态抵押配置

每个版本以 `(Spoke 地址, reserveId, dynamicConfigKey)` 标识，
通过 `getDynamicReserveConfig(reserveId, key)` 获取。

| 字段 | 类型 / 单位 | 含义 |
|---|---|---|
| `collateralFactor` | uint16 / BPS | 抵押价值计入借款能力的比例 |
| `maxLiquidationBonus` | uint32 / BPS | 本金加最大清算奖励的比例 |
| `liquidationFee` | uint16 / BPS | 协议从清算奖励中收取的比例 |

例如 `collateralFactor=8000` 表示 80%；`maxLiquidationBonus=10500` 表示额外奖励最多为 5%。
若 `liquidationFee=1000`，协议从奖励部分收取 10%，不能按整个清算本金的 10% 理解。

动态 key 从 0 开始，新增版本会推进最新 key。已有仓位可能继续引用旧版本；
旧 key 的配置可以原地修改，因此最新 key 不等于该 reserve 唯一有效的配置。
参见 [ISpoke 的 DynamicReserveConfig](https://github.com/aave/aave-v4/blob/main/src/spoke/interfaces/ISpoke.sol)。

### Oracle 与 position manager

| 实体 | 字段 | 含义 / 接口 |
|---|---|---|
| Oracle | `spoke` | 绑定的 Spoke，`spoke()` |
| Oracle | `decimals` | 报价精度，`decimals()` |
| Oracle → reserve | `priceSource` | reserve 的价格源，`getReserveSource(reserveId)` |
| Spoke → position manager | `active` | 是否允许该 manager，`isPositionManagerActive(address)` |

价格源地址与实时价格是不同的概念。第三方价格适配器的阈值、有效期等内部配置由其自身接口定义。
Position manager 的市场级启用状态也不同于用户授予它的个人授权。
Spoke 没有公开 manager 地址枚举 getter，仅已知地址可查询其 active，无法仅从一个 Hub 地址获得完整 manager 集合。
参见 [IAaveOracle](https://github.com/aave/aave-v4/blob/main/src/spoke/interfaces/IAaveOracle.sol)
和 [ISpoke](https://github.com/aave/aave-v4/blob/main/src/spoke/interfaces/ISpoke.sol)。

## Treasury 与 Configurator

| 实体 | 字段 | 含义 |
|---|---|---|
| Treasury | `owner` | 当前所有者 |
| Treasury | `pendingOwner` | Ownable2Step 的待接任所有者；零地址表示无待接任者 |
| Configurator | `authority` | 管理其配置函数的权限合约 |

Hub 资产的 `feeReceiver` 引用接收费用的 Spoke，官方 Treasury 使用 Ownable2Step 所有权模型。
HubConfigurator / SpokeConfigurator 提供配置操作入口，实际资产、reserve 参数仍归属于 Hub / Spoke。
官方角色表包含 HubConfigurator domain admin `200` 与 SpokeConfigurator domain admin `400`。
参见 [TreasurySpoke](https://github.com/aave/aave-v4/blob/main/src/spoke/TreasurySpoke.sol)、
[HubConfigurator](https://github.com/aave/aave-v4/blob/main/src/hub/HubConfigurator.sol)、
[SpokeConfigurator](https://github.com/aave/aave-v4/blob/main/src/spoke/SpokeConfigurator.sol)
及 [Roles](https://github.com/aave/aave-v4/blob/main/src/deployments/utils/libraries/Roles.sol)。

## TokenizationSpoke

TokenizationSpoke 是单个 Hub 资产的 ERC-4626 包装器，通过 `hub()`、`assetId()`、`asset()`、
`decimals()` 表达关联 Hub、资产 ID、底层 token 与精度。它不是拥有 reserve 和清算配置的借贷 Spoke。
Treasury、Tokenization 和借贷 Spoke 的官方实例都可能公开 `SPOKE_REVISION()`，revision 不是类型标识。
参见 [ITokenizationSpoke](https://github.com/aave/aave-v4/blob/main/src/spoke/interfaces/ITokenizationSpoke.sol)。

## Authority 权限对象

Hub、Spoke、Configurator 通过 `authority` 引用权限合约。官方 AccessManagerEnumerable
组织角色、角色成员、目标合约以及目标函数的权限关系。

### 角色与成员

| 所属对象 | 字段 | 含义 / 单位 | 接口 |
|---|---|---|---|
| Role | `admin` | 可以管理该角色的角色 ID | `getRoleAdmin` |
| Role | `guardian` | 可以取消该角色排队操作的角色 ID | `getRoleGuardian` |
| Role | `grantDelay` | 新成员授权生效等待时间，秒 | `getRoleGrantDelay` |
| Role → member | `since` | 成员授权生效时间，Unix 时间戳 | `getAccess` |
| Role → member | `currentDelay` | 当前执行延迟，秒 | 同上 |
| Role → member | `pendingDelay` | 待生效执行延迟，秒 | 同上 |
| Role → member | `effect` | 待变更延迟的生效时间，Unix 时间戳 | 同上 |

`ADMIN_ROLE = 0` 是管理员角色；`PUBLIC_ROLE = 2^64 - 1` 表示所有调用者，不通过逐个成员授权表达。
角色 ID、成员地址共同标识一条成员关系。

### 目标与函数权限

| 所属对象 | 字段 | 含义 / 单位 | 接口 |
|---|---|---|---|
| Target | `closed` | 是否关闭目标合约的受控调用 | `isTargetClosed` |
| Target | `adminDelay` | 目标管理操作延迟，秒 | `getTargetAdminDelay` |
| Target → function | `role` | 该 selector 要求的角色 ID | `getTargetFunctionRole` |

函数权限以 `(Authority 地址, target 地址, selector)` 标识。
枚举接口不包含 ADMIN 的函数归属；未显式配置的函数权限默认归属 ADMIN。
配置为 PUBLIC 的函数允许所有调用者，不表示存在一份 PUBLIC 成员清单。
参见 [AccessManagerEnumerable](https://github.com/aave/aave-v4/blob/main/src/access/AccessManagerEnumerable.sol)
与 [AccessManager](https://github.com/aave/aave-v4/blob/main/src/dependencies/openzeppelin/AccessManager.sol)。

## 合约部署与升级关系

每个合约以网络和地址标识。采用 ERC-1967 的代理使用 implementation、admin、beacon 存储槽表达升级关系。

| 字段 | 含义 |
|---|---|
| `codeHash` | 当前地址 runtime code 的 keccak256 |
| `implementation` | ERC-1967 implementation 槽对应地址 |
| `implementationCodeHash` | implementation 的代码哈希 |
| `admin` | ERC-1967 admin 槽对应地址 |
| `adminCodeHash` | admin 地址的代码哈希 |
| `adminOwner` | 官方 ProxyAdmin 的所有者 |
| `beacon` | ERC-1967 beacon 槽对应地址 |
| `beaconCodeHash` | beacon 的代码哈希 |
| `beaconOwner` | beacon 的所有者 |
| `beaconImplementation` | beacon 指向的 implementation |
| `beaconImplementationCodeHash` | beacon implementation 的代码哈希 |

零地址表示相应存储槽未设置。EOA admin 不存在 ProxyAdmin owner；普通合约或 EOA 不必具有这些代理关系。
代码哈希是部署信息，不是可直接设置的治理参数。非 ERC-1967 升级机制由相应合约自身定义。
标准借贷 Spoke 继承 `ExtSload`，通过 `extSloads(bytes32[])` 暴露这些槽；
Hub、Treasury、Tokenization 没有这一接口，其代理升级槽不能通过外部 Reader 直接读取。
`EXTCODEHASH` 可读取所有地址的代码哈希，但不代表能读取任意代理内部状态。
参见 [ERC-1967](https://eips.ethereum.org/EIPS/eip-1967)
与 [Aave V4 deployments](https://github.com/aave/aave-v4/blob/main/src/deployments/README.md)。

## GraphQL 暴露的配置

Aave V4 GraphQL 按 Hub、HubAsset、Spoke、Reserve 和 HubSpokeConfig 暴露市场配置。
API 对象与合约字段的命名和数值表示不完全相同：

| API 字段 | 协议配置 | 表示差异 |
|---|---|---|
| HubAsset.settings | 资产费用、费用接收方、策略和再投资控制器 | 未配置的再投资控制器可返回 null |
| optimalUtilizationRate / baseBorrowRate / slopeBelowOptimal / slopeAboveOptimal | optimalUsageRatio / baseDrawnRate / rateGrowthBeforeOptimal / rateGrowthAfterOptimal | PercentNumber.onChainValue 为 BPS |
| HubSpokeConfig.supplyCap / borrowCap | addCap / drawCap | 金额带 decimals；合约 cap 是整枚资产数量 |
| Spoke.liquidationConfig | Spoke 的三个清算参数 | 健康因子为十进制字符串；合约为 WAD；对象可为 null |
| Reserve.settings / status | reserve 风险系数和操作开关 | 不包含价格源地址 |
| latestDynamicConfigKey 和三个动态参数 | 最新动态配置版本 | 不提供按任意历史 key 查询的完整配置集合 |
| maxLiquidationBonus | 最大清算奖励 | API 表示额外奖励；合约包含 10000 BPS 本金 |
| spokePositionManagers | manager 地址和启用状态 | 支持分页，并可包含 inactive manager |

HubSpokeConfig 查询要求指定 Hub 和 Spoke ID；API 可识别的 Spoke 集合不保证覆盖 Hub
链上注册的全部特殊 Spoke。用户仓位中的旧动态配置也不等于完整历史配置枚举。

当前公开 schema 未提供 Hub/Spoke/Configurator 的 authority、权限角色与成员、目标函数权限、
Treasury 所有权、Spoke Oracle/清算逻辑地址和用户 reserve 数量限制、Oracle 精度与价格源地址，
以及合约代码和代理升级关系。

参见 [官方 GraphQL schema](https://github.com/aave/aave-v4-sdk/blob/main/packages/graphql/schema.graphql)
和 [Aave V4 GraphQL 文档](https://www.aave.com/docs/aave-v4/getting-started/graphql)。
