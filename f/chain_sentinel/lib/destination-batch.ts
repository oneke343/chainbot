//native

export async function sendBatch<T, R>(
  items: T[],
  sender: (item: T, index: number) => Promise<R>,
  concurrency = 4,
): Promise<R[]> {
  if (!Array.isArray(items) || items.length > 100) throw new Error("messages must contain at most 100 items");
  const results: R[] = [];
  for (let offset = 0; offset < items.length; offset += concurrency) {
    results.push(...await Promise.all(
      items.slice(offset, offset + concurrency).map((item, index) => sender(item, offset + index)),
    ));
  }
  return results;
}
