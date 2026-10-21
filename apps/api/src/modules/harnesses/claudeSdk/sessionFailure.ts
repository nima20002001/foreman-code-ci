import type { ClaudeManagerContext, Runtime } from './sessionTypes.js'
import { record } from './sessionState.js'

/** A failed publication and a failed native stream share the same owned runtime cleanup. */
export async function failRuntime(ctx: ClaudeManagerContext, runtime: Runtime, error: unknown): Promise<void> {
  runtime.failure = error
  closeOutput(runtime, error)
  await record(ctx, runtime, 'claude.session.failed', {
    nativeSessionId: runtime.session?.nativeSessionId,
    error: { code: 'CLAUDE_NATIVE_STREAM_ERROR',
      message: error instanceof Error ? error.message : 'The native Claude query failed.' },
  })
  runtime.rejectInit(error)
  await runtime.sdk.close()
}

export function closeOutput(runtime: Runtime, error: unknown, turnError = error): void {
  runtime.closed = true
  delete runtime.httpCredentialAcknowledgement
  // Output failure cannot establish whether an already offered command was delivered.
  runtime.compaction?.fail(error)
  runtime.active?.events.close(turnError)
}
