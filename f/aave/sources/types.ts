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