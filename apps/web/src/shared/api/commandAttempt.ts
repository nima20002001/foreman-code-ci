/** Keep the same command identity while an outcome is unknown. No timers or automatic retries. */
export class CommandAttempt<T extends object> {
  private pending: { input: T; commandId: string } | undefined

  input(value: T): T & { commandId: string } {
    if (this.pending && JSON.stringify(this.pending.input) !== JSON.stringify(value)) {
      throw new Error('The previous request has an unknown outcome. Retry its original values before submitting a different request.')
    }
    this.pending ??= { input: structuredClone(value), commandId: crypto.randomUUID() }
    return { ...this.pending.input, commandId: this.pending.commandId }
  }

  succeeded(): void { this.pending = undefined }
  failed(error: unknown): void {
    // A structured 4xx rejection is definitive. Transport, response-validation,
    // timeout and server failures can follow a commit, so retain their identity.
    if (commandWasRejected(error)) this.pending = undefined
  }
  get unresolved(): boolean { return this.pending !== undefined }
}
/** Only a structured rejection proves that a write did not commit. */
export function commandWasRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  if (error.code === 'INVALID_REQUEST') return true
  return 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.status !== 429 && error.code !== 'HTTP_ERROR' && error.code !== 'INVALID_RESPONSE'
}
