// The Bun runner initializes the checkpoint context required by workflow().
import { taskScript, workflow } from "windmill-client";
import { formatUnits, parseUnits } from "viem";
import type {
  AaveV3ChainsQuery,
  AaveV3MarketParamsQuery,
} from "../../lib/v3-types.ts";

const queryChains = taskScript("f/aave/sources/v3/chains", {
  cache_ttl: 86400,
});
const queryMarketParams = taskScript("f/aave/sources/v3/market_params_query", {
  timeout: 60,
});

type Market = AaveV3MarketParamsQuery["markets"][number];
type Reserve = Market["reserves"][number];
type Decimal = Reserve["supplyInfo"]["maxLTV"];

function decimal(value: Decimal): string {
  return formatUnits(BigInt(value.raw), value.decimals);
}

function reserveConfiguration(reserve: Reserve) {
  const { supplyInfo, borrowInfo, isolationModeConfig } = reserve;
  return {
    symbol: reserve.underlyingToken.symbol,
    decimals: reserve.underlyingToken.decimals,
    aToken: reserve.aToken.address.toLowerCase(),
    vToken: reserve.vToken.address.toLowerCase(),
    usdOracleAddress: reserve.usdOracleAddress.toLowerCase(),
    interestRateStrategyAddress:
      reserve.interestRateStrategyAddress.toLowerCase(),
    isFrozen: reserve.isFrozen,
    isPaused: reserve.isPaused,
    flashLoanEnabled: reserve.flashLoanEnabled,
    supplyInfo: {
      maxLTV: decimal(supplyInfo.maxLTV),
      liquidationThreshold: decimal(supplyInfo.liquidationThreshold),
      liquidationBonus: decimal(supplyInfo.liquidationBonus),
      canBeCollateral: supplyInfo.canBeCollateral,
      supplyCap: decimal(supplyInfo.supplyCap.amount),
    },
    borrowInfo:
      borrowInfo === null
        ? null
        : {
            reserveFactor: decimal(borrowInfo.reserveFactor),
            borrowCap: decimal(borrowInfo.borrowCap.amount),
            borrowingState: borrowInfo.borrowingState,
            baseVariableBorrowRate: decimal(borrowInfo.baseVariableBorrowRate),
            variableRateSlope1: decimal(borrowInfo.variableRateSlope1),
            variableRateSlope2: decimal(borrowInfo.variableRateSlope2),
            optimalUsageRate: decimal(borrowInfo.optimalUsageRate),
          },
    isolationModeConfig:
      isolationModeConfig === null
        ? null
        : {
            canBeCollateral: isolationModeConfig.canBeCollateral,
            canBeBorrowed: isolationModeConfig.canBeBorrowed,
            debtCeiling: formatUnits(
              parseUnits(isolationModeConfig.debtCeiling.usd, 2),
              2,
            ),
            debtCeilingDecimals: isolationModeConfig.debtCeilingDecimals,
          },
  };
}

function marketConfiguration(market: Market) {
  return {
    name: market.name,
    reserves: Object.fromEntries(
      market.reserves.map((reserve) => [
        reserve.underlyingToken.address.toLowerCase(),
        reserveConfiguration(reserve),
      ]),
    ),
  };
}

export type Snapshot = Record<
  string,
  Record<string, ReturnType<typeof marketConfiguration>>
>;

export const main = workflow(async (api: RT.Graphql): Promise<Snapshot> => {
  const { chains }: AaveV3ChainsQuery = await queryChains({ api });
  const { markets }: AaveV3MarketParamsQuery = await queryMarketParams({
    api,
    chain_ids: chains.map((chain) => chain.chainId),
  });
  const snapshot: Snapshot = Object.fromEntries(
    chains.map((chain) => [String(chain.chainId), {}]),
  );
  for (const market of markets) {
    snapshot[String(market.chain.chainId)][market.address.toLowerCase()] =
      marketConfiguration(market);
  }
  return snapshot;
});
