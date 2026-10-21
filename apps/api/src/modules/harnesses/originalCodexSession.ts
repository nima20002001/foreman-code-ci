import type { ApprovalResponseOption, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeSessionStart } from './port.js'
import type { CodexAppServerSessionManager, CodexOriginalSessionLifetime } from './codexAppServer.js'

export interface OriginalCodexSession extends CodexOriginalSessionLifetime {
  reattach(signal?: AbortSignal): Promise<NativeSessionReference>
  cancel(signal?: AbortSignal): Promise<boolean>
  respond(nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void>
}

/** The caller supplies the original role/lease/writer/physical process fence.
 * This adapter cannot acquire ownership, allocate a manager or recover cold loss. */
export function captureOriginalCodexSession(manager: CodexAppServerSessionManager, session: NativeSessionReference,
  source: NativeSessionStart, assertOwnerCurrent: () => void): OriginalCodexSession | undefined {
  assertOwnerCurrent()
  const reference = structuredClone(session), start = structuredClone(source)
  const lifetime = manager.originalSessionLifetime(reference, start)
  if (!lifetime) return undefined
  const pin = structuredClone(lifetime.residency)
  const assertCurrent = () => { assertOwnerCurrent(); lifetime.assertCurrent() }
  assertCurrent()
  const perform = async <T>(operation: () => Promise<T>, signal?: AbortSignal) => {
    signal?.throwIfAborted(); assertCurrent()
    const result = await operation()
    signal?.throwIfAborted(); assertCurrent()
    return result
  }
  return { residency: structuredClone(pin), assertCurrent,
    reattach: signal => perform(() => manager.reattachOriginalSession(reference, start, pin, signal), signal),
    cancel: signal => perform(() => manager.cancelOriginalTurn(reference, start, pin, signal), signal),
    respond: (requestId, option, signal) => perform(() => manager.respondOriginal(reference, start, pin, requestId, option, signal), signal),
  }
}
