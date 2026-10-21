import type { NativeMcpInspector, NativeMcpStatus } from '../mcpDetection.js'
import { HarnessExecutionError } from '../errors.js'
import type { NativeSessionStart } from '../port.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'
import { appMcpServerName } from '../appMcpLauncher.js'

/** Reads control status and acknowledged credential metadata from the same
 * owned query. Saved HTTP settings and token presence alone confer no proof. */
export function claudeProductionMcpInspector(input: {
  manager(): ClaudeNativeSessionManager
  start(): Promise<NativeSessionStart>
  workingDirectory: string
  cliVersion: string
}): NativeMcpInspector {
  return { async inspect(request) {
    if (request.harness !== 'claude' || request.workingDirectory !== input.workingDirectory) {
      throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH', 'MCP inspection must use the admitted Claude working directory.')
    }
    request.signal?.throwIfAborted()
    const snapshot = await input.manager().prepareInspection(await input.start(), request.signal)
    const name = appMcpServerName(Object.fromEntries(snapshot.servers.map((entry) => [entry.name, entry])), request.serverName)
    const server = snapshot.servers.find(entry => entry.name === name)
    const status: Record<string, NativeMcpStatus> = { connected: 'connected', failed: 'broken',
      'needs-auth': 'authentication_required', pending: 'status_unavailable', disabled: 'disabled' }
    return { harness: 'claude', providerVersion: input.cliVersion, runnerId: request.runnerId,
      workingDirectory: input.workingDirectory, inspectedAt: snapshot.checkedAt, generation: snapshot.generation,
      ...(snapshot.currentAuthorizationScope ? { authorizationScope: snapshot.currentAuthorizationScope } : {}),
      ...(server ? { entry: { name: server.name,
        transport: server.configuration?.type === 'http' ? 'streamable-http' as const
          : server.configuration?.type === 'sse' ? 'sse' as const : server.configuration?.type === 'stdio' ? 'stdio' as const : 'unknown' as const,
        ...(server.configuration?.url ? { endpoint: server.configuration.url } : {}),
        enabled: server.status !== 'disabled', status: status[server.status]!, enabledTools: server.toolNames,
        credentialArrangement: snapshot.httpCredentialAcknowledgement?.serverName === server.name
          ? { kind: 'scoped_http_header' as const, acknowledgement: snapshot.httpCredentialAcknowledgement }
          : { kind: 'unknown' as const },
      } } : {}),
    }
  } }
}
