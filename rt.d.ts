declare namespace RT {
  interface COkx {
    url: string;
    api_key: string;
    api_secret: string;
    passphrase: string;
  }

  interface CBinance {
    url: string;
    api_key: string;
    api_secret: string;
  }

  interface Graphql {
    base_url: string;
    bearer_token?: string;
    custom_headers?: Record<string, string>;
  }
  interface Telegram {
    token: string;
  }

  interface CFlashduty {
    url: string;
    integration_key: string;
  }

  interface CAlertMessage {
    title: string;
    description: string;
    severity: "info" | "warning" | "critical";
    fields: Record<string, unknown>;
  }
}
