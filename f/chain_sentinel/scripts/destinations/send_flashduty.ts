//native

type FlashdutyApiResponse = {
  request_id?: string;
  error?: {
    code: string;
    message?: string;
  };
  data?: {
    alert_key?: string;
  };
};

type FlashdutyPayload = {
  title_rule: string;
  event_status: "Critical" | "Warning" | "Info";
  alert_key?: string;
  description: string;
  labels: Record<string, string>;
};

export async function main(
  destination: RT.Flashduty,
  message?: RT.AlertMessage | null,
  alert_key?: string,
) {
  if (!message) return;
  if (!destination?.url) {
    throw new Error("FlashDuty url is required");
  }
  if (!destination?.integration_key) {
    throw new Error("FlashDuty integration_key is required");
  }

  const payload: FlashdutyPayload = {
    title_rule: message.title,
    event_status: toFlashdutyEventStatus(message.severity),
    ...(alert_key ? { alert_key: alert_key.slice(0, 255) } : {}),
    description: message.description,
    labels: buildFlashdutyLabels(message),
  };
  const requestUrl = new URL(destination.url);
  if (!["http:", "https:"].includes(requestUrl.protocol)) {
    throw new Error("FlashDuty url must use http or https");
  }
  requestUrl.searchParams.set("integration_key", destination.integration_key);

  const response = await fetch(requestUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let apiPayload: FlashdutyApiResponse;
  try {
    apiPayload = await response.json() as FlashdutyApiResponse;
  } catch (error) {
    throw new Error(`Invalid FlashDuty API response: ${describeError(error)}`);
  }

  if (!response.ok || apiPayload.error) {
    throw new Error(describeFlashdutyError(apiPayload, response.status));
  }

  return {
    destination: "flashduty",
    delivered: true,
    request_id: apiPayload.request_id,
    alert_key: apiPayload.data?.alert_key,
  };
}

function toFlashdutyEventStatus(
  severity: RT.AlertMessage["severity"],
): FlashdutyPayload["event_status"] {
  switch (severity) {
    case "critical":
      return "Critical";
    case "warning":
      return "Warning";
    case "info":
      return "Info";
  }
}

function buildFlashdutyLabels(message: RT.AlertMessage): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(message.fields).map(([key, value]) => [key, stringifyLabel(value)]),
    ),
    severity: message.severity,
  };
}

function stringifyLabel(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function describeFlashdutyError(
  payload: FlashdutyApiResponse,
  status: number,
): string {
  if (!payload.error) return `FlashDuty API error ${status}`;
  return payload.error.message
    ? `${payload.error.code}: ${payload.error.message}`
    : payload.error.code;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
