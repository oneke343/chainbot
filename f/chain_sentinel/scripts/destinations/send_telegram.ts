//native

export async function main(
  auth: RT.Telegram,
  chat_id: string,
  message?: RT.AlertMessage | null,
) {
  if (!message) return;
  if (!auth?.token) throw new Error("Telegram token is required");
  if (!chat_id) throw new Error("Telegram chat_id is required");
  const fields = message.fields && Object.keys(message.fields).length > 0
    ? `\n${JSON.stringify(message.fields)}`
    : "";
  const summary = `[${message.severity.toUpperCase()}] ${message.title}\n${message.description}`;
  // Large all-market snapshots stay in Windmill; Telegram accepts at most 4096 characters.
  const text = summary.length + fields.length <= 4096
    ? summary + fields
    : `${summary.slice(0, 4000)}\n[Full fields are available in the Windmill job result.]`;
  const response = await fetch(`https://api.telegram.org/bot${auth.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Telegram delivery failed (${response.status}): ${responseText.slice(0, 500)}`);
  }
  return { destination: "telegram", delivered: true };
}
