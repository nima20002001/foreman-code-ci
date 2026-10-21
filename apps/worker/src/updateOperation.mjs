export async function waitForUpdateOperation(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const aborted = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), aborted]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
