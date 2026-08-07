/**
 * Rejects if `promise` has not settled in time. The page-level budget in
 * browser.mjs covers a single browser interaction; this covers a whole candidate,
 * which may involve several of them plus HTTP fetches.
 */
export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超過 ${Math.round(ms / 1000)}s 未完成`)), ms);
    }),
  ]);
}

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
