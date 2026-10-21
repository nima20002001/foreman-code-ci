/** Native success is returned only after the original owner's cleanup succeeds. */
export async function runOwnedClaudeOperation<T>(operation: () => Promise<T>, close: () => Promise<void>): Promise<T> {
  const result = await Promise.resolve().then(operation).then(
    value => ({ kind: 'value' as const, value }),
    (error: unknown) => ({ kind: 'error' as const, error }),
  )
  try { await close() }
  catch (error) {
    if (result.kind === 'error') throw new AggregateError([result.error, error],
      'Claude operation and native cleanup both failed.', { cause: error })
    throw error
  }
  if (result.kind === 'error') throw result.error
  return result.value
}
