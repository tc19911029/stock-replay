/**
 * Fetch with exponential backoff retry.
 * Retries on network errors and 5xx responses (not 4xx).
 */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit & { maxRetries?: number; baseDelay?: number },
): Promise<Response> {
  const { maxRetries = 3, baseDelay = 500, ...fetchInit } = init ?? {};

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(input, fetchInit);
      // Don't retry client errors (4xx), only server errors (5xx)
      if (res.ok || (res.status >= 400 && res.status < 500)) return res;
      if (attempt < maxRetries) {
        await sleep(baseDelay * Math.pow(2, attempt));
        continue;
      }
      return res; // Return last failed response
    } catch (err) {
      lastError = err;
      // Don't retry if aborted
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      if (attempt < maxRetries) {
        await sleep(baseDelay * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
