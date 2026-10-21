export async function closeTestResources(steps: Array<() => Promise<unknown>>): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try { await step() }
    catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Test resource cleanup failed.')
}
