export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 3, baseDelayMs = 1000 } = {},
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
