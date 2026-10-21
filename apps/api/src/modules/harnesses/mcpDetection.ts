import { endpointMatches } from './nativeMcpEndpoint.js'
export { endpointMatches } from './nativeMcpEndpoint.js'
import {
  McpDetectionSchema,
  ScopedMcpDetectionSchema,
  GraphqlAgentToolSchema,
  type AgentHarness,
  type McpDetection,
  type McpCredentialArrangement,
  type ScopedMcpDetection,
  type PairedMcpEndpoint,
  PairedMcpEndpointSchema,
} from '@foreman-code/contracts'
import type pg from 'pg'
import type { ChildProcessEnvironment } from './port.js'

import type { IssuedWorkerCredential, WorkerCredentialService } from '../access/workerCredentials.js'
import { WORKER_CREDENTIAL_EXPIRY_MARGIN_MS } from '../access/credentialLifetime.js'
import { DomainError } from '../errors.js'
import { HarnessExecutionError } from './errors.js'
import { APP_MCP_SERVER_NAME, isSupportedAppMcpServerName, isSupportedAppMcpTokenName } from './appMcpLauncher.js'

// Cover binary hashing, qualification, and MCP lookups; each native command still has its own 30-second bound.
export const MCP_INSPECTION_TIMEOUT_MS = 120_000
export type NativeMcpStatus = 'connected' | 'disabled' | 'authentication_required' | 'broken' | 'status_unavailable'
export type McpInspectionPhase = 'configuration' | 'health'

/** Internal receipt metadata from the owned SDK control operation, never credential values. */
export interface NativeMcpHttpCredentialAcknowledgement {
  source: 'sdk_set_mcp_servers'
  serverName: string
  endpoint: string
  generation: string
  authorizationScope: string
}

export type NativeMcpCredentialArrangement =
  | { kind: 'environment_variable'; environmentVariable: string }
  | { kind: 'scoped_http_header'; acknowledgement: NativeMcpHttpCredentialAcknowledgement }
  | { kind: 'unknown' }

export interface NativeMcpEntryEvidence {
  /** The managed launcher routes to the owning app instance; no fixed endpoint is configured. */
  automaticEndpoint?: boolean
  pairedEndpoint?: PairedMcpEndpoint
  name: string
  transport: 'streamable-http' | 'sse' | 'stdio' | 'unknown'
  endpoint?: string
  enabled?: boolean
  credentialEnvironmentVariable?: string
  credentialArrangement?: NativeMcpCredentialArrangement
  status?: NativeMcpStatus
  detail?: string
  enabledTools?: readonly string[]
  disabledTools?: readonly string[]
  nativeFilterDiagnostics?: readonly string[]
}

export interface NativeMcpInspectionEvidence {
  harness: AgentHarness
  providerVersion: string
  runnerId: string
  workingDirectory: string
  inspectedAt: string
  generation?: string
  authorizationScope?: string
  entry?: NativeMcpEntryEvidence
}

export interface NativeMcpInspector {
  inspect(input: {
    harness: AgentHarness
    runnerId: string
    workingDirectory: string
    serverName: string
    signal?: AbortSignal
    phase?: McpInspectionPhase
  }): Promise<NativeMcpInspectionEvidence>
}

// Diagnostic text is never a raw provider response. Even perfectly valid JSON
// config errors can include credentials under unexpected keys or quoted fields.
const details: Record<McpDetection['state'], string> = {
  connected: 'The native provider reports an active MCP connection.',
  not_detected: 'The named native MCP entry is absent.',
  disabled: 'The native MCP entry is disabled.',
  misconfigured: 'The native MCP endpoint, transport, or scoped Bearer authentication does not match this application.',
  authentication_required: 'The native MCP connection requires authentication. Configuration can be checked before scoped credentials are injected.',
  broken: 'The native provider reports a failed MCP connection.',
  status_unavailable: 'Native configuration is available; connection health has not been established.',
  check_failed: 'Native MCP inspection failed. Check provider configuration and command access.',
}
const appTools = new Set<string>(GraphqlAgentToolSchema.options)
function toolFilter(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error('Invalid native tool filter.')
  // Unknown tool names cannot grant access to the current App catalog. Do not
  // echo arbitrary configuration strings as diagnostic data.
  return values.filter((value) => typeof value === 'string' && appTools.has(value))
}

export class McpDetectionService {
  constructor(
    private readonly inspector: NativeMcpInspector,
    private readonly expectedEndpoint: string,
    private readonly serverName: string = APP_MCP_SERVER_NAME,
    private readonly timeoutMs = MCP_INSPECTION_TIMEOUT_MS,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw new RangeError('Invalid MCP inspection timeout.')
    if (!endpointMatches(expectedEndpoint, expectedEndpoint)) throw new RangeError('Invalid App MCP endpoint.')
  }

  async inspect(input: {
    harness: AgentHarness
    runnerId: string
    workingDirectory: string
    signal?: AbortSignal
    phase?: McpInspectionPhase
  }): Promise<ScopedMcpDetection> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(new Error('MCP inspection deadline exceeded.')), this.timeoutMs)
    timeout.unref()
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal
    let abort: (() => void) | undefined
    try {
      signal.throwIfAborted()
      const canceled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('MCP inspection canceled.'))
        signal.addEventListener('abort', abort, { once: true })
      })
      const evidence = await Promise.race([
        Promise.resolve().then(() => this.inspector.inspect({ ...input, signal, serverName: this.serverName })),
        canceled,
      ])
      signal.throwIfAborted()
      if (evidence.harness !== input.harness || evidence.runnerId !== input.runnerId
        || evidence.workingDirectory !== input.workingDirectory) {
        throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'Native MCP inspection returned evidence for another launch context.', 500)
      }
      const entry = evidence.entry
      const nameMatches = entry?.name === this.serverName || isSupportedAppMcpServerName(this.serverName)
        && entry !== undefined && isSupportedAppMcpServerName(entry.name)
      const automatic = entry?.automaticEndpoint === true && entry.transport === 'stdio' && nameMatches
        && isSupportedAppMcpServerName(this.serverName)
      const pairedResult = PairedMcpEndpointSchema.safeParse(entry?.pairedEndpoint)
      const paired = pairedResult.success ? pairedResult.data : undefined
      const pairedMatches = Boolean(paired && input.harness === 'claude' && `device:${paired.deviceId}` === input.runnerId
        && endpointMatches(paired.configuredEndpoint, this.expectedEndpoint)
        && endpointMatches(entry?.endpoint, paired.nativeEndpoint))
      const matches = entry ? automatic || pairedMatches || endpointMatches(entry.endpoint, this.expectedEndpoint) : null
      const arrangement = entry?.credentialArrangement
      const credentialVariable = arrangement?.kind === 'environment_variable'
        ? arrangement.environmentVariable : entry?.credentialEnvironmentVariable
      const supportedCredential = isSupportedAppMcpTokenName(credentialVariable) ? credentialVariable : undefined
      const environmentMatches = (arrangement === undefined || arrangement.kind === 'environment_variable')
        && supportedCredential !== undefined
      const acknowledgement = arrangement?.kind === 'scoped_http_header' ? arrangement.acknowledgement : undefined
      const headerMatches = Boolean(acknowledgement && input.harness === 'claude'
        && entry?.transport === 'streamable-http' && entry.status === 'connected'
        && acknowledgement.source === 'sdk_set_mcp_servers' && acknowledgement.serverName === entry?.name && nameMatches
        && endpointMatches(acknowledgement.endpoint, pairedMatches ? paired!.nativeEndpoint : this.expectedEndpoint)
        && matches && evidence.generation && acknowledgement.generation === evidence.generation
        && evidence.authorizationScope && acknowledgement.authorizationScope === evidence.authorizationScope)
      const credentialArrangement: McpCredentialArrangement = environmentMatches
        ? { kind: 'environment_variable', environmentVariable: supportedCredential! }
        : headerMatches ? { kind: 'scoped_http_header' } : { kind: 'unknown' }
      const credentialMatches = environmentMatches || headerMatches
      let state: McpDetection['state']
      if (!entry) state = 'not_detected'
      else if (!nameMatches || !matches || !credentialMatches || (entry.transport !== 'streamable-http' && !automatic)) state = 'misconfigured'
      else if (entry.enabled === false || entry.status === 'disabled') state = 'disabled'
      else if (entry.status === 'connected' || entry.status === 'authentication_required' || entry.status === 'broken') state = entry.status
      else state = 'status_unavailable'
      return ScopedMcpDetectionSchema.parse({
        detection: McpDetectionSchema.parse({
          harness: input.harness, serverName: entry?.name ?? this.serverName, state, endpointMatches: matches,
          credentialEnvironmentVariable: environmentMatches ? supportedCredential : null,
          credentialArrangement,
          checkedAt: new Date().toISOString(), detail: details[state],
        }),
        runnerId: input.runnerId, workingDirectory: input.workingDirectory,
        providerVersion: /^(?:codex-cli )?\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(evidence.providerVersion) ? evidence.providerVersion : 'unknown',
        nativeFilters: {
          ...(entry?.enabledTools !== undefined ? { enabledTools: toolFilter(entry.enabledTools) } : {}),
          ...(entry?.disabledTools !== undefined ? { disabledTools: toolFilter(entry.disabledTools) } : {}),
          ...(entry?.nativeFilterDiagnostics?.length ? { diagnostics: ['Native permission filters are configured; inspect their details in the native client.'] } : {}),
        },
      })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'MCP_INSPECTION_CONTEXT_MISMATCH') throw error
      let reportedCode: string | undefined
      if (error instanceof DomainError) reportedCode = error.code
      else if (error instanceof HarnessExecutionError) reportedCode = error.result.error?.code
      const canceled = input.signal?.aborted === true
      const timedOut = !canceled && (controller.signal.aborted
        || error instanceof Error && error.name === 'TimeoutError')
      let failureCode = reportedCode && /^[A-Z][A-Z0-9_]{0,95}$/u.test(reportedCode)
        ? reportedCode : 'NATIVE_MCP_INSPECTION_FAILED'
      let detail = details.check_failed
      if (canceled) {
        failureCode = 'NATIVE_MCP_INSPECTION_CANCELED'
        detail = 'Native MCP inspection was canceled.'
      } else if (timedOut) {
        failureCode = 'NATIVE_MCP_INSPECTION_TIMEOUT'
        detail = 'Native MCP inspection timed out. Retry after the provider finishes starting.'
      }
      return ScopedMcpDetectionSchema.parse({
        detection: McpDetectionSchema.parse({
          harness: input.harness, serverName: this.serverName, state: 'check_failed',
          endpointMatches: null, credentialEnvironmentVariable: null, checkedAt: new Date().toISOString(),
          credentialArrangement: { kind: 'unknown' },
          detail,
        }),
        runnerId: input.runnerId, workingDirectory: input.workingDirectory, providerVersion: 'unknown',
        nativeFilters: { diagnostics: [failureCode] },
      })
    } finally {
      clearTimeout(timeout)
      if (abort) signal.removeEventListener('abort', abort)
    }
  }

  async preflight(input: {
    harness: AgentHarness
    runnerId: string
    workingDirectory: string
    signal?: AbortSignal
  }): Promise<ScopedMcpDetection> {
    const result = await this.inspect({ ...input, phase: 'configuration' })
    input.signal?.throwIfAborted()
    if (result.nativeFilters.diagnostics?.includes('NATIVE_MCP_INSPECTION_TIMEOUT')) {
      throw new DomainError('APP_MCP_PREFLIGHT_TIMEOUT',
        'Foreman Code MCP inspection timed out before credentials could be injected. Retry after the provider finishes starting.',
        409, { inspectionCodes: result.nativeFilters.diagnostics })
    }
    // A correctly configured bearer endpoint may require the not-yet-issued
    // token. This does NOT accept broken connections or relax config checks.
    if (!['connected', 'status_unavailable', 'authentication_required'].includes(result.detection.state)) {
      throw new DomainError('APP_MCP_PREFLIGHT_FAILED', result.detection.state === 'not_detected'
        ? `Foreman Code MCP is not installed for ${input.harness === 'codex' ? 'Codex' : 'Claude'}. Add it in Harness Settings › Connections, then start again.`
        : `Foreman Code MCP credential injection refused: ${result.detection.state}.`, 409,
      { inspectionCodes: result.nativeFilters.diagnostics ?? [] })
    }
    input.signal?.throwIfAborted()
    return result
  }
}

/** Native filters only remove tools from the already-authorized App catalog. */
export function intersectNativeToolFilters(
  authorized: readonly string[],
  filters: ScopedMcpDetection['nativeFilters'],
): string[] {
  const enabled = filters.enabledTools ? new Set(filters.enabledTools) : undefined
  const disabled = new Set(filters.disabledTools ?? [])
  return authorized.filter((tool) => (!enabled || enabled.has(tool)) && !disabled.has(tool))
}

export class WorkerLaunchCredentialService implements ExecutionCredentialProvider {
  constructor(
    private readonly detection: Pick<McpDetectionService, 'preflight'>,
    private readonly credentials: WorkerCredentialService,
    private readonly runnerId: string,
    maximumExecutionMs = 300_000,
  ) {
    if (!Number.isSafeInteger(maximumExecutionMs) || maximumExecutionMs < 1
      || maximumExecutionMs > credentials.ttlMs - WORKER_CREDENTIAL_EXPIRY_MARGIN_MS) {
      throw new RangeError('The execution timeout must end at least 30 seconds before the App credential expires.')
    }
  }

  async prepare(input: ExecutionCredentialPrepareInput): Promise<PreparedExecutionCredential> {
    const detection = await this.detection.preflight({
      harness: input.harness, runnerId: this.runnerId, workingDirectory: input.workingDirectory,
      ...(input.signal ? { signal: input.signal } : {}),
    })
    input.signal?.throwIfAborted()
    const credentials = this.credentials as WorkerCredentialService & {
      revokeSupersededForExecution?(executionId: string): Promise<number>
    }
    if (credentials.revokeSupersededForExecution) await credentials.revokeSupersededForExecution(input.executionId)
    else await credentials.revokeForExecution(input.executionId)
    input.signal?.throwIfAborted()
    // The engine retains the returned credential before its final launch check,
    // including an abort that races issuance, and always performs terminal cleanup.
    const credential = await (input.purpose === 'reviewer'
      ? credentials.issueForReviewer(input.executionId) : credentials.issueForExecution(input.executionId))
    if (input.signal?.aborted) {
      await this.credentials.revoke(credential)
      input.signal.throwIfAborted()
    }
    return { credential, detection }
  }

  renew(executionId: string, credential: Pick<IssuedWorkerCredential, 'principalId'>): Promise<string> {
    return this.credentials.renewForExecution(executionId, credential)
  }

  revoke(credential: Pick<IssuedWorkerCredential, 'principalId'>): Promise<void> {
    return this.credentials.revoke(credential)
  }

  revokeForExecution(executionId: string): Promise<number> {
    return this.credentials.revokeForExecution(executionId)
  }
  revokeForRun(runId: string, client?: pg.PoolClient): Promise<number> { return this.credentials.revokeForRun(runId, client) }
  reconcileTerminalCredentials(): Promise<void> { return this.credentials.reconcileTerminalCredentials() }
}

export interface ExecutionCredentialPrepareInput {
  purpose?: 'reviewer'
  executionId: string
  harness: AgentHarness
  workingDirectory: string
  signal?: AbortSignal
}

export interface PreparedExecutionCredential {
  credential: IssuedWorkerCredential
  detection: ScopedMcpDetection
}

/** Provider-neutral lifecycle seam consumed by legacy and rich session execution paths. */
export interface ExecutionCredentialProvider {
  recoverRemote?(executionId: string, access: import('@foreman-code/contracts/remote-execution').RemoteApplicationAccess,
    job?: import('@foreman-code/contracts').ReviewJob):
    Promise<IssuedWorkerCredential>
  bindReviewerJob?(executionId: string, credential: Pick<IssuedWorkerCredential, 'principalId'>,
    job: import('@foreman-code/contracts').ReviewJob, lane?: import('../interactions/sessionWriter.js').SessionWriteLease): Promise<void>
  /** New process only; never inject a replacement environment into a resident process. */
  prepare(input: ExecutionCredentialPrepareInput): Promise<PreparedExecutionCredential>
  /** Verify the retained original environment without issuing another process credential. */
  restore?(executionId: string, environment: ChildProcessEnvironment): Promise<IssuedWorkerCredential>
  /** Same-token server-side lease renewal. Providers without it must not rotate a busy process. */
  renew?(executionId: string, credential: Pick<IssuedWorkerCredential, 'principalId'>, signal?: AbortSignal): Promise<string>
  revoke(credential: Pick<IssuedWorkerCredential, 'principalId'>): Promise<void>
  revokeForExecution(executionId: string): Promise<number>
  revokeForRun?(runId: string, client?: pg.PoolClient): Promise<number>
  reconcileTerminalCredentials?(): Promise<void>
}
