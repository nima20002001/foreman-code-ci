import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import type { ClaudeNativeSessionManager } from '../../harnesses/claudeSdk/sessionManager.js'
import type { ClaudeFileCallResolver } from './server.js'

const NativeMetadata = z.object({
  signal: z.instanceof(AbortSignal),
  _meta: z.object({ 'claudecode/toolUseId': z.string().min(1).max(500) }).passthrough(),
}).passthrough()

/** Provider-written metadata is a lookup key, never admission by itself.
 * The installed CLI overwrites this field after user metadata; SDK MCP extra
 * carries params._meta unchanged. Only the manager's unique observed root
 * tool/message map and captured accepted authority can produce file identity.
 */
export function createClaudeFileCallResolver(input: {
  manager(): Pick<ClaudeNativeSessionManager,
    'waitNativeCallbackContext' | 'nativeCallbackContext' | 'callbackAuthority'> | undefined
  signal: AbortSignal
}): ClaudeFileCallResolver {
  return { resolve: async (_operation, extra) => {
    if (!extra || typeof extra !== 'object' || !Object.hasOwn(extra, '_meta')) return undefined
    const metadata: unknown = Reflect.get(extra, '_meta')
    if (!metadata || typeof metadata !== 'object' || !Object.hasOwn(metadata, 'claudecode/toolUseId')) return undefined
    const parsed = NativeMetadata.safeParse(extra)
    if (!parsed.success || input.signal.aborted || parsed.data.signal.aborted) return undefined
    const manager = input.manager()
    if (!manager) return undefined
    const toolUseId = parsed.data._meta['claudecode/toolUseId']
    const signal = AbortSignal.any([input.signal, parsed.data.signal])
    try {
      const context = await manager.waitNativeCallbackContext(toolUseId, signal)
      signal.throwIfAborted()
      // Recheck after the ACK wait: a result, close, failed runtime, ambiguous
      // owner or changed generation must not retain a previously captured owner.
      const current = manager.nativeCallbackContext(context.nativeSessionId, toolUseId)
      if (input.manager() !== manager || !current || !isDeepStrictEqual(current, context)) return undefined
      const authority = manager.callbackAuthority(context)
      if (!authority || signal.aborted) return undefined
      return { ...context, ...authority, toolUseId }
    } catch { return undefined }
  } }
}
