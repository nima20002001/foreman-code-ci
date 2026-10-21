import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { DomainError } from '../../errors.js'
import { componentLogger } from '../../diagnostics/logger.js'
import { appMcpServerName } from '../appMcpLauncher.js'
import { hasWorkflowRequest } from '../sessionStart.js'
import type { ExecutionCredentialPrepareInput, McpDetectionService, NativeMcpInspector } from '../mcpDetection.js'
import type { Wave25WorkerCredentialService } from '../../interactions/wave25/credentials.js'
import type { productionClaudeManager } from './production.js'
import { assertClaudeCredentialEndpoint } from './mcpInspection.js'

/** Production workflow preflight over the allocated manager and its original SDK query. */
export async function prepareClaudeWorkflowCredentials(options: {
  input: ExecutionCredentialPrepareInput
  configuration: ClaudeHarnessConfiguration
  claude: Pick<ReturnType<typeof productionClaudeManager>, 'manager' | 'inspectionStart'>
  inspector: NativeMcpInspector
  detection: Pick<McpDetectionService, 'preflight'>
  credentials: Pick<Wave25WorkerCredentialService, 'issueForConsultation' | 'issueForReviewer' | 'issueForExecution'
    | 'revokeSupersededForExecution' | 'revoke'>
  runnerId: string
  endpoint: string
  refreshRoutes(): Promise<void>
}) {
  const { input, configuration, claude, inspector, detection, credentials, runnerId, endpoint, refreshRoutes } = options
  const inspected = await inspector.inspect({ harness: 'claude', runnerId,
    workingDirectory: input.workingDirectory, serverName: PRODUCT_SLUG, phase: 'configuration', ...(input.signal ? { signal: input.signal } : {}) })
  assertClaudeCredentialEndpoint(inspected.entry, endpoint)
  if (input.purpose !== 'consultation') await credentials.revokeSupersededForExecution(input.executionId)
  input.signal?.throwIfAborted()
  if (input.purpose === 'consultation' && !input.consultation) throw new DomainError(
    'CONSULTATION_CREDENTIAL_UNAVAILABLE', 'The exact consultation binding is required.', 409)
  const issue = () => {
    if (input.purpose === 'consultation') return credentials.issueForConsultation(input.consultation!)
    if (input.purpose === 'reviewer') return credentials.issueForReviewer(input.executionId)
    return credentials.issueForExecution(input.executionId)
  }
  const credential = await issue()
  try {
    const token = readProductEnvironment(credential.environment.variables, 'MCP_TOKEN')
    const serverName = appMcpServerName(configuration.mcpServers)
    const configured = configuration.mcpServers[serverName]
    if (!token || configured?.type !== 'http' || configured.url !== endpoint) throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'The accepted Claude settings cannot receive this scoped HTTP credential.', 409)
    const inspectedStart = await claude.inspectionStart()
    if (!hasWorkflowRequest(inspectedStart)) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE',
      'Workflow credential preparation requires its original execution request.', 409)
    const start = input.purpose === 'consultation'
      ? { kind: 'workflow-consultation' as const, request: inspectedStart.request,
        consultation: input.consultation!, correlationId: `consultation:${input.consultation!.consultationId}`,
        environment: credential.environment, instructionsDelivered: true as const }
      : { ...inspectedStart, environment: credential.environment }
    const servers = { ...configuration.mcpServers,
      [serverName]: { ...configured, headers: { Authorization: `Bearer ${token}` } } }
    if (input.session) {
      if (start.kind === 'workflow-consultation') {
        if (!claude.manager.rebindApplicationAccess) throw new DomainError('NATIVE_CREDENTIAL_REBIND_UNAVAILABLE',
          'The retained Claude session cannot change its application subject.', 409)
        await claude.manager.rebindApplicationAccess(input.session, start, input.signal)
      }
      await claude.manager.refreshSessionCredentials(input.session, start, servers, input.signal)
    } else {
      await claude.manager.refreshInspectionCredentials(start, servers, input.signal)
    }
    const checked = await detection.preflight({ harness: 'claude', runnerId,
      workingDirectory: input.workingDirectory, ...(input.signal ? { signal: input.signal } : {}) })
    if (checked.detection.state !== 'connected' || checked.detection.credentialArrangement?.kind !== 'scoped_http_header') {
      componentLogger('harness').warn({ executionId: input.executionId, state: checked.detection.state,
        arrangement: checked.detection.credentialArrangement?.kind ?? null }, 'Claude scoped MCP credential preflight rejected')
      throw new DomainError('APP_MCP_PREFLIGHT_FAILED', 'Claude did not acknowledge the scoped HTTP credential on its current query.', 409)
    }
    await refreshRoutes()
    return { credential, detection: checked }
  } catch (error) {
    componentLogger('harness').warn({ executionId: input.executionId, code: error instanceof DomainError ? error.code
      : error instanceof Error ? error.constructor.name : typeof error }, 'Claude workflow credential preflight failed')
    await credentials.revoke(credential); throw error
  }
}
