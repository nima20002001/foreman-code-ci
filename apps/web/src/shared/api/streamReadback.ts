/** Invalidations during an in-flight read require a trailing read, not a lost deduplicated GET. */
export function createStreamReadback(read: () => Promise<unknown>, latencyMs = 100) {
  let timer: ReturnType<typeof setTimeout> | undefined, reading = false, dirty = false, disposed = false
  const request = () => {
    if (disposed) return
    dirty = true
    if (reading || timer) return
    timer = setTimeout(async () => {
      timer = undefined
      if (disposed) return
      reading = true; dirty = false
      try { await read() } catch { /* Request owner retains errors and authorization denial. */ }
      finally { reading = false; if (dirty && !disposed) request() }
    }, latencyMs)
  }
  return { request, dispose() { disposed = true; dirty = false; clearTimeout(timer); timer = undefined } }
}
