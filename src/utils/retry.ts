export async function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let id: NodeJS.Timeout;
  const timeout = new Promise<T>((_, rej) => { id = setTimeout(() => rej(new Error('OPERATION_TIMEOUT')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(id!));
}

export async function withRetry<T>(op: () => Promise<T>, maxRetries = 3, baseDelayMs = 1000, timeoutMs = 5000): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try { return await withTimeout(op(), timeoutMs); }
    catch (err) {
      if (attempt >= maxRetries) throw err;
      await new Promise(r => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw new Error('Unreachable');
}
