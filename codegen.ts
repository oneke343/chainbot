import { globSync } from "node:fs";
import type { CodegenConfig } from "@graphql-codegen/cli";

const documents = globSync("f/aave/**/*.gql").sort();

const config: CodegenConfig = {
  generates: {
    ...Object.fromEntries(
      ["v3", "v4"].map((version) => [
        `f/aave/lib/${version}-types.ts`,
        {
          schema: `https://api.${version}.aave.com/graphql`,
          documents: documents.filter((document) =>
            document.includes(`/sources/${version}/`)
          ),
          plugins: ["typescript-operations"],
          config: { inlineCommonTypes: true },
        },
      ]),
    ),
    "f/morpho/lib/types.ts": {
      schema: "https://api.morpho.org/graphql",
      documents: ["f/morpho/**/*.gql"],
      plugins: ["typescript-operations"],
    },
  },
  config: {
    useTypeImports: true,
    defaultScalarType: "unknown",
    scalars: {
      ID: "string",
      Address: "string",
      MarketId: "string",
      HexString: "string",
      EvmAddress: "string",
      ChainId: "number",
      BigDecimal: "string",
      BigInt: "string",
      DateTime: "string",
      Cursor: "string",
      HealthFactor: "string",
      ReserveId: "string",
      SpokeId: "string",
      HubId: "string",
      OnChainHubAssetId: "string",
      TxHash: "string",
      URL: "string",
    },
  },
};

export default config;
