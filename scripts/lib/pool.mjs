/** Runs `worker` over `items` with a fixed number of slots in flight. */
export async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        results[index] = { error: String(err?.message ?? err) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
