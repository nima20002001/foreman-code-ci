/** Evidence about entry into the mutating native operation, not an error-code guess. */
export class NativeMcpNotSubmittedError extends Error {
  constructor(cause: unknown) {
    super('The native MCP write was not entered.', { cause })
    this.name = 'NativeMcpNotSubmittedError'
  }
}

/** The adapter calls writing() immediately before its sole irreversible operation. */
export async function withNativeMcpDelivery<T>(operation: (writing: () => void) => Promise<T>): Promise<T> {
  let entered = false
  try { return await operation(() => { entered = true }) }
  catch (error) {
    if (!entered) throw new NativeMcpNotSubmittedError(error)
    throw error
  }
}
