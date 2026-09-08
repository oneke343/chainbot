declare namespace RT {
  interface Graphql {
    base_url: string;
    bearer_token?: string;
    custom_headers?: Record<string, string>;
  }
  interface HttpConnection {
    base_url: string;
    bearer_token?: string;
    headers?: Record<string, string>;
  }

  interface Telegram {
    token: string;
  }

  interface Flashduty {
    url: string;
    integration_key: string;
  }

  interface SparkLend {
    markets: Array<{
      name: string;
      chain_id: number;
      chain_name: string;
      pool_address: string;
      rpc_url: string;
      rpc_headers?: Record<string, string>;
      base_currency_decimals?: number;
    }>;
  }

  interface AlertMessage {
    title: string;
    description: string;
    severity: "info" | "warning" | "critical";
    fields: Record<string, unknown>;
  }

  interface MonitorOutput {
    matched: boolean;
    messages: {
      title: string;
      description: string;
      fields?: Record<string, unknown>;
    }[];
    fields: Record<string, unknown>;
  }

  interface MonitorState {
    inputs: Record<string, unknown>;
    states: Record<string, unknown>;
    outputs: MonitorOutput;
  }
}
