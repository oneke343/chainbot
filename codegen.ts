import { globSync } from "node:fs";
import { basename } from "node:path";
import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  generates: Object.fromEntries(
    globSync("f/aave/**/*.gql").sort().map((document) => [
      document.replace(/\.gql$/, ".types.ts"),
      {
        schema: basename(document).startsWith("aave_v4_")
          ? "https://api.v4.aave.com/graphql"
          : "https://api.v3.aave.com/graphql",
        documents: document,
        plugins: ["typescript-operations"],
      },
    ]),
  ),
  config: {
    useTypeImports: true,
    defaultScalarType: "unknown",
    scalars: {
      ID: "string",
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
