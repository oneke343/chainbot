//native

import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";

export type AccountMode = Awaited<ReturnType<InfoClient["userAbstraction"]>>;

export type Position = {
  id: string;
  dex: string;
  coin: string;
  marginMode: "cross" | "isolated";
  size: string;
  entryPrice: string | null;
  markPrice: string;
  liquidationPrice: string | null;
  positionValue: string;
  unrealizedPnl: string;
  marginUsed: string;
  stateTime: number;
  marketFetchedAt: number;
};

export type DexMargin = {
  dex: string;
  stateTime: number;
  collateralToken: number;
  crossAccountValue: string;
  crossMaintenanceMarginUsed: string;
};

export type Snapshot = {
  address: string;
  network: "mainnet" | "testnet";
  accountMode: AccountMode;
  startedAt: number;
  completedAt: number;
  positions: Position[];
  marginData: {
    dexs: DexMargin[];
    spotBalances: { token: number; total: string }[] | null;
    spotFetchedAt: number | null;
  };
};

export async function main(
  address: string,
  network: "mainnet" | "testnet" = "mainnet",
): Promise<Snapshot> {
  address = address.toLowerCase();
  const startedAt = Date.now();
  const info = new InfoClient({
    transport: new HttpTransport({
      isTestnet: network === "testnet",
      timeout: 8_000,
    }),
  });

  const [perpDexs, accountMode] = await Promise.all([
    info.perpDexs(),
    info.userAbstraction({ user: address }),
  ]);
  // The null entry represents the validator-operated DEX, named "" in requests.
  const dexNames = perpDexs.map((dex) => (dex === null ? "" : dex.name));
  const needsSpot =
    accountMode === "unifiedAccount" || accountMode === "portfolioMargin";

  async function collectDex(dex: string) {
    const [state, [meta, contexts]] = await Promise.all([
      info.clearinghouseState({ user: address, dex }),
      info.metaAndAssetCtxs({ dex }),
    ]);
    const marketFetchedAt = Date.now();
    const marks = new Map(
      meta.universe.map((asset, i) => [asset.name, contexts[i]]),
    );
    const positions: Position[] = state.assetPositions
      .filter(({ position }) => Number(position.szi) !== 0)
      .map(({ position: p }) => ({
        id: `${network}:${address}:${dex}:${p.coin}`,
        dex,
        coin: p.coin,
        marginMode: p.leverage.type,
        size: p.szi,
        entryPrice: p.entryPx,
        markPrice: marks.get(p.coin)!.markPx,
        liquidationPrice: p.liquidationPx,
        positionValue: p.positionValue,
        unrealizedPnl: p.unrealizedPnl,
        marginUsed: p.marginUsed,
        stateTime: state.time,
        marketFetchedAt,
      }));
    const margin: DexMargin = {
      dex,
      stateTime: state.time,
      collateralToken: meta.collateralToken,
      crossAccountValue: state.crossMarginSummary.accountValue,
      crossMaintenanceMarginUsed: state.crossMaintenanceMarginUsed,
    };
    return { positions, margin };
  }

  async function collectDexs() {
    const results: Awaited<ReturnType<typeof collectDex>>[] = [];
    for (let i = 0; i < dexNames.length; i += 4) {
      results.push(
        ...(await Promise.all(dexNames.slice(i, i + 4).map(collectDex))),
      );
    }
    return results;
  }

  const [dexs, spot] = await Promise.all([
    collectDexs(),
    needsSpot
      ? info.spotClearinghouseState({ user: address }).then((state) => ({
          // Outcome balances have no collateral token id.
          balances: state.balances
            .filter((balance) => "token" in balance)
            .map(({ token, total }) => ({ token, total })),
          fetchedAt: Date.now(),
        }))
      : Promise.resolve(null),
  ]);
  return {
    address,
    network,
    accountMode,
    startedAt,
    completedAt: Date.now(),
    positions: dexs.flatMap((dex) => dex.positions),
    marginData: {
      dexs: dexs.map((dex) => dex.margin),
      spotBalances: spot === null ? null : spot.balances,
      spotFetchedAt: spot === null ? null : spot.fetchedAt,
    },
  };
}
