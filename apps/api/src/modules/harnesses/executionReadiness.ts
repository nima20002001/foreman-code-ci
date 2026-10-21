import type { AgentHarness, HarnessConfiguration } from '@foreman-code/contracts'
import { ExecutionReadinessSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { HarnessCatalogService } from './catalog.js'
import type { NativeRollout } from './nativeRollout.js'
import { DomainError } from '../errors.js'

/** Model-free qualification of saved defaults; run-specific admission remains authoritative. */
export class ExecutionReadinessService {
  constructor(private readonly rollout: Pick<NativeRollout, 'enabled'>,
    private readonly catalog: Pick<HarnessCatalogService, 'get'>,
    private readonly operatorConfiguration?: (principal: ManagementPrincipal, configurationVersionId?: string) => Promise<{
      configurationVersionId: string; harness: HarnessConfiguration; defaultsRevision: number | null
    }>) {}

  async get(principal: ManagementPrincipal, harness: AgentHarness,
    scope: 'saved-harness-defaults' | 'operator-configuration' = 'saved-harness-defaults', configurationVersionId?: string) {
    requireAuthorization(principal, 'harnesses:read')
    const rolloutEnabled = this.rollout.enabled(harness)
    let entry: Awaited<ReturnType<HarnessCatalogService['get']>> | null = null
    let setupReason: { code: string; message: string } | null = null
    let operator: Awaited<ReturnType<NonNullable<ExecutionReadinessService['operatorConfiguration']>>> | undefined
    if (rolloutEnabled) {
      try {
        if (scope === 'operator-configuration') {
          if (!this.operatorConfiguration) throw new DomainError('READINESS_UNAVAILABLE', 'Operator configuration readiness is unavailable.', 503)
          operator = await this.operatorConfiguration(principal, configurationVersionId)
          if (operator.harness.harness !== harness || (configurationVersionId && operator.configurationVersionId !== configurationVersionId)) {
            throw new DomainError('OPERATOR_CONFIGURATION_CONFLICT', 'The requested harness does not match the saved Operator configuration.', 409)
          }
        } else entry = await this.catalog.get(principal, harness)
      }
      catch (error) {
        if (!(error instanceof DomainError) || (scope === 'saved-harness-defaults' ? error.code !== 'HARNESS_PROFILE_REQUIRED'
          : ![409, 422, 503].includes(error.status) || error.code === 'READINESS_UNAVAILABLE')) throw error
        setupReason = { code: error.code, message: error.message }
      }
    }
    const reason = !rolloutEnabled ? {
      code: 'NATIVE_ROLLOUT_DISABLED',
      message: harness === 'codex'
        ? 'Codex execution is disabled by this app’s runtime configuration.'
        : 'Claude execution is disabled by this app’s runtime configuration.',
    } : setupReason ?? entry?.discoveryError ?? null
    const unverified = reason && /CHECK_TIMEOUT|QUALIFICATION_FAILED|DISCOVERY_UNAVAILABLE|STATUS_REFRESHING/.test(reason.code)
    return ExecutionReadinessSchema.parse({
      harness, scope, ...(operator || configurationVersionId ? { configurationVersionId: operator?.configurationVersionId ?? configurationVersionId } : {}),
      status: unverified ? 'unverified' : reason ? 'blocked' : 'eligible', rolloutEnabled,
      defaultsRevision: operator?.defaultsRevision ?? entry?.defaultsRevision ?? null,
      checkedAt: entry && 'observation' in entry ? entry.observation.checkedAt ?? new Date().toISOString()
        : new Date().toISOString(), reason,
      limitation: scope === 'operator-configuration'
        ? 'This checks the exact saved Operator configuration and current host profile. Workspace, permissions, and MCP policy are checked again at execution.'
        : 'This checks the workflow harness preset only. Operator configurations have their own host profiles; each configuration, workspace, permissions, and MCP policy is checked again at execution.',
    })
  }
}
