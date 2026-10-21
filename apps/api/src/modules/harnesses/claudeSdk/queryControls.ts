import type { ClaudeSdkQuery, ClaudeSdkSession } from './port.js'

export function claudeQueryControls(current: () => ClaudeSdkQuery | undefined, signal: AbortSignal):
Pick<ClaudeSdkSession, 'getContextUsage' | 'setPermissionMode' | 'interrupt' | 'initializationResult'
  | 'mcpServerStatus' | 'setMcpServers'> {
  return {
    async getContextUsage(options) {
      signal.throwIfAborted()
      const query = current()
      if (!query?.getContextUsage) throw new Error('Claude SDK context inspection is unavailable')
      return query.getContextUsage(options)
    },
    async setPermissionMode(mode) {
      signal.throwIfAborted()
      const query = current()
      if (!query?.setPermissionMode) throw new Error('Claude SDK Plan control is unavailable')
      await query.setPermissionMode(mode)
    },
    async interrupt() {
      signal.throwIfAborted()
      const query = current()
      if (!query) throw new Error('Claude SDK not initialized')
      // This is a session-wide native interrupt, not expected-turn cancellation proof.
      return query.interrupt()
    },
    async initializationResult() {
      signal.throwIfAborted()
      const query = current()
      if (!query?.initializationResult) throw new Error('Claude SDK initialization inspection is unavailable')
      return query.initializationResult()
    },
    async mcpServerStatus() {
      signal.throwIfAborted()
      const query = current()
      if (!query?.mcpServerStatus) throw new Error('Claude SDK live MCP control inspection is unavailable')
      return query.mcpServerStatus()
    },
    async setMcpServers(servers) {
      signal.throwIfAborted()
      const query = current()
      if (!query?.setMcpServers) throw new Error('Claude SDK scoped MCP control update is unavailable')
      return query.setMcpServers(servers)
    },
  }
}
