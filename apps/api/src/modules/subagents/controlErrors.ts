/** Positive evidence that this dispatch did not accept input. Never use for lost replies. */
export class SubagentDispatchRejectedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The native child command was rejected before acceptance.', options)
    this.name = 'SubagentDispatchRejectedError'
  }
}
