export async function withTimeout<T>(promise: Promise<T>, ms: number = 5000): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('OPERATION_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
  timeoutMs = 5000
): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await withTimeout(operation(), timeoutMs);
    } catch (error) {
      attempt++;
      if (attempt >= maxRetries) {
        throw error;
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(`[Retry] Operation failed, retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`, error);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("Unreachable");
}
