export interface AaveV3UserPosition {
    marketName: string;
    marketAddress: string;
    chainId: number;
    chainName: string;
    eModeEnabled: boolean;
    healthFactor: string;
    totalDebtBase: string;
    totalCollateralBase: string;
}

export interface AaveV4UserPosition {
    spokeName: string;
    spokeAddress: string;
    chainId: number;
    chainName: string;
    healthFactor: string;
    averageCollateralFactor: string;
    totalDebtUsd: string;
    totalCollateralUsd: string;
}
