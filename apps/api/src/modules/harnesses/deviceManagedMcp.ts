import type pg from 'pg'
import { ScopedMcpDetectionSchema } from '@foreman-code/contracts'
import { DeviceRegistrationSchema, type CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { MANAGED_MCP_NAMESPACE, ManagedMcpFailureSchema, type ManagedMcpRequest }
  from '@foreman-code/contracts/managed-mcp-channel'
import { HarnessMcpListResultSchema, HarnessMcpPlanSchema, type HarnessMcpManagedInput,
  type HarnessMcpPlan, type HarnessMcpReconcileInput, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'

type Harness = 'codex' | 'claude'
/** Main authorizes and records the command; the current paired Worker owns the native write. */
export class DeviceManagedMcp {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly endpoint: () => Pick<DeviceEndpoint, 'captureRequest'> | undefined,
    private readonly commands: PostgresCommandCoordinator) {}

  private async target(sql: Pick<pg.Pool, 'query'>, host: CanonicalMachineReference): Promise<DeviceProvisioningTarget> {
    if (host.kind !== 'device' || host.mainId !== this.mainId) throw new DomainError('COMPUTER_NOT_FOUND', 'Paired computer unavailable.', 404)
    const row = (await sql.query<{ record: unknown }>(`select record from device_registrations
      where main_id=$1 and record->>'deviceId'=$2 and record->>'status'='paired'`, [this.mainId, host.deviceId])).rows[0]
    if (!row) throw new DomainError('COMPUTER_NOT_FOUND', 'This computer is not paired.', 404)
    const registration = DeviceRegistrationSchema.parse(row.record)
    return { hostRef: host, applicationInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }
  }
  private async request(target: DeviceProvisioningTarget, request: ManagedMcpRequest, signal?: AbortSignal) {
    if (target.hostRef.kind !== 'device') throw new DomainError('COMPUTER_NOT_FOUND', 'Paired computer required.', 404)
    const captured = this.endpoint()?.captureRequest(target.hostRef.deviceId, MANAGED_MCP_NAMESPACE)
    if (!captured) throw new DomainError('COMPUTER_OFFLINE', 'This computer is offline or needs a Worker update.', 409)
    const binding = captured.binding
    const current = { hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      applicationInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
      authorizationRevision: binding.authorizationRevision }
    if (!isDeepStrictEqual(target, current)) throw new DomainError('COMPUTER_NOT_FOUND', 'The paired computer changed.', 409)
    const deadline = AbortSignal.timeout(120_000)
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline
    let payload: unknown
    try {
      payload = (await captured.request({ target, request }, { signal: bounded, timeoutMs: 120_000 })).payload
    } catch (error) {
      if (error instanceof DeviceApplicationError) {
        throw new DomainError(error.code, error.message, error.retryable ? 503 : 409, undefined, { cause: error })
      }
      throw error
    }
    const failure = ManagedMcpFailureSchema.safeParse(payload)
    if (failure.success) {
      const { code, message, status } = failure.data.error
      throw new DomainError(code, message, status)
    }
    return payload
  }
  async list(principal: ManagementPrincipal, harness: Harness, hostRef: CanonicalMachineReference) {
    requireAuthorization(principal, 'harnesses:read')
    const target = await this.target(this.pool, hostRef)
    const result = HarnessMcpListResultSchema.parse(await this.request(target, { operation: 'list', harness }))
    if (result.harness !== harness) throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'Another harness was inspected.', 409)
    return { ...result, hostRef }
  }
  async inspect(principal: ManagementPrincipal, harness: Harness, hostRef: CanonicalMachineReference,
    resource: { workspaceId: string } | undefined = undefined) {
    requireAuthorization(principal, 'harnesses:read', resource)
    const target = await this.target(this.pool, hostRef)
    const result = ScopedMcpDetectionSchema.parse(await this.request(target, { operation: 'detect', harness }))
    if (result.detection.harness !== harness || target.hostRef.kind !== 'device'
      || result.runnerId !== target.hostRef.deviceId) {
      throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'Another harness was inspected.', 409)
    }
    return result
  }
  async apply(principal: ManagementPrincipal, input: HarnessMcpManagedInput, source: 'http' | 'mcp') {
    requireAuthorization(principal, 'harnesses:read')
    requireAuthorization(principal, 'harnesses:update')
    if (!input.hostRef) throw new DomainError('COMPUTER_NOT_FOUND', 'Paired computer required.', 404)
    const target = await this.target(this.pool, input.hostRef)
    const result = await this.commands.execute({ principal, source, operation: 'harness.mcp.managed.device',
      commandId: input.commandId, targetKey: `harness-mcp:${this.mainId}:${input.hostRef.kind === 'device' ? input.hostRef.deviceId : ''}:${input.harness}`,
      payload: input, authorize: async client => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(live, 'harnesses:update')
        requireAuthorization(live, 'harnesses:read')
        if (!isDeepStrictEqual(target, await this.target(client, input.hostRef!))) {
          throw new DomainError('COMPUTER_NOT_FOUND', 'The paired installation changed.', 409)
        }
      }, perform: async client => {
        const plan = HarnessMcpPlanSchema.parse(await this.request(target, { operation: 'apply', input, requestedBy: principal.id }))
        if (plan.harness !== input.harness || !isDeepStrictEqual(plan.hostRef, input.hostRef)
          || plan.requestedBy !== principal.id) throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'The MCP result belongs to another request.', 409)
        await client.query(`insert into harness_mcp_change_plans
          (id,harness,revision,change,managed_preset,requested_by,status,created_at,expires_at,error,host_ref)
          values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11::jsonb)
          on conflict(id) do nothing`, [plan.id, plan.harness, plan.revision, JSON.stringify(plan.change), plan.managedPreset,
          principal.id, plan.status, plan.createdAt, plan.expiresAt, plan.error, JSON.stringify(input.hostRef)])
        return plan
      } })
    return result.value
  }
  async reconcile(principal: ManagementPrincipal, input: HarnessMcpReconcileInput, plan: HarnessMcpPlan, source: 'http' | 'mcp') {
    requireAuthorization(principal, 'harnesses:read')
    requireAuthorization(principal, 'harnesses:update')
    if (!plan.hostRef) throw new DomainError('COMPUTER_NOT_FOUND', 'Paired computer required.', 404)
    const target = await this.target(this.pool, plan.hostRef)
    return this.commands.execute({ principal, source, operation: 'harness.mcp.device.reconcile',
      commandId: input.commandId, targetKey: `harness-mcp:${this.mainId}:${plan.id}`, payload: input,
      authorize: async client => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(live, 'harnesses:update')
        requireAuthorization(live, 'harnesses:read')
        if (!isDeepStrictEqual(target, await this.target(client, plan.hostRef!))) {
          throw new DomainError('COMPUTER_NOT_FOUND', 'The paired installation changed.', 409)
        }
      }, perform: async client => {
        const settled = HarnessMcpPlanSchema.parse(await this.request(target, { operation: 'reconcile', input, plan }))
        if (settled.id !== plan.id || !isDeepStrictEqual(settled.hostRef, plan.hostRef)) {
          throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'The MCP result belongs to another request.', 409)
        }
        await client.query('update harness_mcp_change_plans set status=$2,error=$3 where id=$1',
          [settled.id, settled.status, settled.error])
        return settled
      } })
  }
}
