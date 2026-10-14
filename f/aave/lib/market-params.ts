//native

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

// Mirror the Reader structs. viem decodes integers through uint48 as numbers;
// larger integers are bigint and are serialized as decimal strings for Windmill.
export type AssetConfig = { feeReceiver: Address; liquidityFee: number; irStrategy: Address; reinvestmentController: Address };
export type SpokeConfig = { addCap: number; drawCap: number; riskPremiumThreshold: number; active: boolean; halted: boolean };
export type InterestRateConfig = { optimalUsageRatio: number; baseDrawnRate: number; rateGrowthBeforeOptimal: number; rateGrowthAfterOptimal: number };
export type RegisteredSpoke = { spoke: Address; config: SpokeConfig };
export type Asset = {
  assetId: string; underlying: Address; decimals: number; underlyingCodeHash: Hex;
  config: AssetConfig; interestRate: InterestRateConfig;
  irStrategyCodeHash: Hex; reinvestmentControllerCodeHash: Hex;
  registeredSpokes: RegisteredSpoke[];
};
export type Hub = { addr: Address; codeHash: Hex; authority: Address; assets: Asset[] };
export type ReserveIdentity = { underlying: Address; hub: Address; assetId: number; decimals: number; collateralRisk: number; flags: number; dynamicConfigKey: number };
export type ReserveConfig = { collateralRisk: number; paused: boolean; frozen: boolean; borrowable: boolean; receiveSharesEnabled: boolean };
export type DynamicReserveConfig = { collateralFactor: number; maxLiquidationBonus: number; liquidationFee: number };
export type LiquidationConfig = { targetHealthFactor: string; healthFactorForMaxBonus: string; liquidationBonusFactor: number };
export type Reserve = {
  reserveId: string; identity: ReserveIdentity; config: ReserveConfig;
  priceSource: Address; priceSourceCodeHash: Hex; dynamicConfigs: DynamicReserveConfig[];
};
export type Oracle = { addr: Address; codeHash: Hex; spoke: Address; decimals: number };
export type Proxy = {
  implementation: Address; implementationCodeHash: Hex;
  admin: Address; adminCodeHash: Hex; adminOwnable: boolean; adminOwner: Address;
  beacon: Address; beaconCodeHash: Hex; beaconOwnable: boolean; beaconOwner: Address;
  beaconImplementation: Address; beaconImplementationCodeHash: Hex;
};
export type Spoke = {
  addr: Address; codeHash: Hex; authority: Address; oracle: Oracle;
  maxUserReservesLimit: number; liquidationLogic: Address; liquidationLogicCodeHash: Hex;
  liquidationConfig: LiquidationConfig; reserves: Reserve[]; proxy: Proxy;
};
export type Treasury = { addr: Address; codeHash: Hex; owner: Address; pendingOwner: Address };
export type Tokenization = { addr: Address; codeHash: Hex; hub: Address; assetId: string; underlying: Address; decimals: number };
export type Member = { account: Address; since: number; currentDelay: number; pendingDelay: number; effect: number };
export type FunctionRole = { selector: Hex; role: string };
export type Target = { target: Address; codeHash: Hex; closed: boolean; adminDelay: number; configuratorAuthority: Address; functions: FunctionRole[] };
export type Role = { roleId: string; admin: string; guardian: string; grantDelay: number; members: Member[]; targets: Target[] };
export type Authority = { addr: Address; codeHash: Hex; enumerable: boolean; roles: Role[]; knownTargets: Target[] };
export type ContractInfo = { addr: Address; codeHash: Hex };
export type HubGraph = { hub: Hub; spokes: Spoke[]; treasuries: Treasury[]; tokenizations: Tokenization[]; otherSpokes: ContractInfo[]; authorities: Authority[] };
export type NetworkParams = Record<Address, HubGraph>;
export type Snapshots = Record<string, NetworkParams>;
export type Baseline = Snapshots;

export type ParamValue = string | number | boolean | null;
export type ParamChange = {
  chain_id: number; path: string; name: string; change: "added" | "updated" | "removed";
  fields: Array<{ parameter: string; before: ParamValue; after: ParamValue }>;
};
export type ParamsMonitorOutput = {
  matched: boolean;
  messages: Array<{ title: string; description: string; fields: { chain_id: number; finding_kind: "market_params_change" } }>;
  fields: { changes: ParamChange[]; observed_objects: number; message_count: number };
};
export type Evaluation = { output: ParamsMonitorOutput; nextBaseline: Baseline };
