/** Four entries bound buffered file content to 64 MiB, including maximum-size files. */
export async function processSourceEntries<Entry>(
  entries: readonly Entry[],
  work: (entry: Entry) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0
  let failure: { error: unknown } | undefined
  const worker = async () => {
    try {
      while (!failure && next < entries.length) {
        signal?.throwIfAborted()
        const entry = entries[next++]!
        await work(entry)
      }
      signal?.throwIfAborted()
    } catch (error) {
      failure ??= { error }
    }
  }
  // Join outstanding I/O before callers close directory handles or activate a tree.
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker))
  if (failure) throw failure.error
  signal?.throwIfAborted()
}
