import { globSync } from "node:fs";
import { basename } from "node:path";
import type { CodegenConfig } from "@graphql-codegen/cli";

const documents = globSync("f/aave/**/*.gql").sort();

const config: CodegenConfig = {
  generates: Object.fromEntries(
    ["v3", "v4"].map((version) => [
      `f/aave/${version}.types.ts`,
      {
        schema: `https://api.${version}.aave.com/graphql`,
        documents: documents.filter((document) =>
          basename(document).startsWith("aave_v4_") === (version === "v4")
        ),
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
