/** Try every independently owned cleanup. Only positive closure removes the
 * callback from the service's retry set. */
export async function closeQualificationResources(resources: readonly {
  close: () => Promise<void>
  release?: (() => void) | undefined
}[]): Promise<void> {
  const results = await Promise.allSettled(resources.map(async ({ close, release }) => {
    await close()
    release?.()
  }))
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Native qualification cleanup was incomplete.')
}
