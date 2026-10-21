/** Byte helpers have no API/domain dependencies; callers validate the contract's size limit first. */
export async function readUploadBytes(file: Blob, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  if (typeof file.arrayBuffer === 'function') {
    const bytes = await file.arrayBuffer()
    signal.throwIfAborted()
    return bytes
  }
  // FileReader also supports the File implementation used by the existing JSDOM tests.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const clean = () => {
      signal.removeEventListener('abort', abort)
      reader.onload = reader.onerror = reader.onabort = null
    }
    const abort = () => {
      clean()
      reader.abort()
      reject(signal.reason)
    }
    reader.onload = () => { clean(); resolve(reader.result as ArrayBuffer) }
    reader.onerror = () => { clean(); reject(reader.error) }
    reader.onabort = () => { clean(); reject(new DOMException('Upload canceled.', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    try { reader.readAsArrayBuffer(file) } catch (error) { clean(); reject(error) }
  })
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Never buffer more than the pinned revision's size, including for chunked responses. */
export async function readExactBytes(response: Response, byteSize: number, signal: AbortSignal): Promise<ArrayBuffer> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) throw new RangeError('Invalid file size.')
  const bytes = new ArrayBuffer(byteSize)
  const output = new Uint8Array(bytes)
  if (!response.body) {
    if (byteSize !== 0) throw new Error('File content is missing.')
    return bytes
  }
  const reader = response.body.getReader()
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  let offset = 0
  let complete = false
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      if (value.byteLength > byteSize - offset) throw new Error('File content exceeds its revision size.')
      output.set(value, offset)
      offset += value.byteLength
    }
    if (offset !== byteSize) throw new Error('File content is truncated.')
    complete = true
    return bytes
  } finally {
    signal.removeEventListener('abort', abort)
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
