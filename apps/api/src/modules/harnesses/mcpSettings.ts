import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { DeviceManagedMcp } from './deviceManagedMcp.js'
import { randomUUID } from 'node:crypto'
import { withClientTransaction } from '../../infrastructure/transaction.js'
import { stat } from 'node:fs/promises'
import type pg from 'pg'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { HarnessMcpManagedInputSchema, HarnessMcpPlanInputSchema, HarnessMcpPlanSchema, HarnessMcpReconcileInputSchema,
  type HarnessMcpManagedInput, type HarnessMcpManagedPreset, type HarnessMcpPlan, type HarnessMcpPlanInput,
  type HarnessMcpReconcileInput, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { assertChange, assertManagedChange, expectedMcpUserFingerprint, managedChange, managedEnableChange, managedStatus, mcpUserFingerprint,
  publicMcpList, type NativeMcpAdapter } from './nativeMcpCommon.js'
import { NativeMcpNotSubmittedError } from './nativeMcpDelivery.js'
import { qualificationError } from './qualificationErrors.js'
import { assertNoUnresolvedPluginWrites, lockNativeConfigurationFile } from './nativeSettingsWrites.js'
import { MCP_INSPECTION_TIMEOUT_MS } from './mcpDetection.js'
import { ignoreError, logIgnoredError } from '../diagnostics/ignoredError.js'

type Harness = 'codex'
type RecordedMcpHarness = Harness | 'claude' | 'opencode'
type McpList = ReturnType<typeof publicMcpList> & { presets?: { graphql: ReturnType<typeof managedStatus>; linear: Exclude<ReturnType<typeof managedStatus>, 'legacy'> } | undefined }
async function fileStamp(file: string): Promise<string | null> {
  try { const info = await stat(file); return info.isFile() ? `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}` : null }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
type Row = { id: string; harness: RecordedMcpHarness; revision: string; change: unknown; managed_preset: HarnessMcpManagedPreset | null;
  requested_by: string; status: string; created_at: Date; expires_at: Date; error: string | null;
  native_user_after_hash: string | null; native_file: string | null; host_ref?: CanonicalMachineReference | null }
const projection = (row: Row): HarnessMcpPlan => HarnessMcpPlanSchema.parse({ id: row.id, harness: row.harness, revision: row.revision,
  change: row.change, ...(row.host_ref ? { hostRef: row.host_ref } : {}), managedPreset: row.managed_preset ?? null, requestedBy: row.requested_by, status: row.status,
  createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), error: row.error,
  ...(row.harness === 'opencode' ? { retirementMessage: RETIRED_OPENCODE_MESSAGE } : {}) })

function assertSupportedHarness(harness: RecordedMcpHarness): asserts harness is Harness {
  if (harness === 'claude') throw new DomainError('MCP_HOST_REQUIRED', 'Claude MCP management requires a paired device hostRef.', 409)
  if (harness === 'opencode') throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
}

/** Preserve the byte-for-byte legacy command payload shape for generic plans. */
export function mcpPlanPayload(input: HarnessMcpPlanInput, managedPreset?: HarnessMcpManagedPreset) {
  return managedPreset === undefined ? input : { ...input, managedPreset }
}
function acceptedPlanMessage(error: unknown): string {
  const code = error instanceof DomainError ? error.code : undefined
  if (code === 'MCP_SETTINGS_BUSY' || code === 'HARNESS_SETTINGS_CLOSING') {
    return 'This plan was accepted, but native settings are busy. Retry the original change; do not create another request.'
  }
  if (code === 'MCP_RECONCILIATION_REQUIRED') return 'This plan was accepted. Reconcile the earlier uncertain write, then retry this original change.'
  if (code === 'REVISION_CONFLICT' || code === 'MCP_PLAN_EXPIRED') {
    return 'This plan was accepted but is no longer current. Reject it, inspect the native configuration, then prepare a new change.'
  }
  return 'This plan was accepted, but applying it was not completed. Retry or review the original change; its command identity is retained.'
}

/** Native configuration writes are external effects: the durable marker precedes the one write. */
export class HarnessMcpSettingsService {
  private readonly stopping = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  // Reuse unchanged user config for at most five minutes; expired reads must finish before serving settings.
  private readonly lists = new Map<Harness, { list: McpList; file: string; stamp: string; readAt: number }>()
  private readonly reads = new Map<Harness, Promise<McpList>>()
  private listGeneration = 0
  private notifyChanged(): void {
    this.listGeneration++
    this.lists.clear()
    this.reads.clear()
    this.changed()
  }
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly adapters: Record<Harness, NativeMcpAdapter>, private readonly changed: () => void,
    private readonly closeProcesses: () => Promise<unknown> = async () => undefined,
    private readonly operatorEndpoint?: string, private devices?: DeviceManagedMcp) {}
  private async work<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopping.signal.aborted) throw new DomainError('HARNESS_SETTINGS_CLOSING', 'Harness settings are shutting down.', 503)
    if (this.pending.size >= 8) throw new DomainError('MCP_SETTINGS_BUSY', 'Native settings are busy. Try again after the current operation finishes.', 503)
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(MCP_INSPECTION_TIMEOUT_MS)])
    const task = Promise.resolve().then(() => run(signal))
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }
  async shutdown(): Promise<void> {
    this.stopping.abort()
    await Promise.allSettled([...this.pending])
    // This callback must complete before the production runtime ownership lock is released.
    await this.closeProcesses()
  }
  async recover(): Promise<void> {
    await this.closeProcesses()
    // Startup alone proves neither delivery nor non-delivery. Settlement is an explicit owner action.
    await this.pool.query("update harness_mcp_change_plans set status='uncertain', error='Server restarted during this change. Use Reconcile in MCP settings; this write will not be repeated.' where status='submitting' and harness='codex' and host_ref is null")
  }
  async list(principal: ManagementPrincipal, harness: Harness | 'claude', hostRef?: CanonicalMachineReference) {
    if (hostRef?.kind === 'device') return this.device().list(principal, harness, hostRef)
    assertSupportedHarness(harness)
    requireAuthorization(principal, 'harnesses:read')
    return this.cachedList(harness)
  }
  configureDevices(devices: DeviceManagedMcp): void { this.devices = devices }
  private device(): DeviceManagedMcp {
    if (!this.devices) throw new DomainError('MCP_PRESET_UNAVAILABLE', 'Paired-device MCP management is unavailable.', 503)
    return this.devices
  }
  async detectDevice(principal: ManagementPrincipal, harness: 'codex' | 'claude', hostRef: CanonicalMachineReference,
    resource?: { workspaceId: string }) {
    return this.device().inspect(principal, harness, hostRef, resource)
  }
  /** Fill Connections before Settings opens. */
  async warmup(harnesses: readonly Harness[]): Promise<void> {
    const results = await Promise.allSettled(harnesses.map((harness) => this.cachedList(harness)))
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') logIgnoredError('harness', 'warm MCP discovery', result.reason,
        { harness: harnesses[index] })
    }
  }
  /** Raw user-layer server entries for fleet sync on Main. Callers must not expose them; they can contain secrets. */
  async userServers(harness: Harness): Promise<Record<string, unknown>> {
    return this.work(async (signal) => structuredClone((await this.adapters[harness].read(signal)).user))
  }
  private async cachedList(harness: Harness): Promise<McpList> {
    const known = this.lists.get(harness)
    const unchanged = known ? await fileStamp(known.file) === known.stamp : false
    if (known && unchanged && Date.now() - known.readAt < 300_000) return structuredClone(known.list)
    const active = this.reads.get(harness)
    const reading = active ?? this.readList(harness)
    if (!active) {
      this.reads.set(harness, reading)
      const clear = () => { if (this.reads.get(harness) === reading) this.reads.delete(harness) }
      void reading.then(clear, clear)
    }
    return reading
  }
  private readList(harness: Harness) {
    const generation = this.listGeneration
    return this.work(async (signal) => {
      try {
        const snapshot = await this.adapters[harness].read(signal)
        const list = publicMcpList(snapshot)
        const result = { ...list, ...(this.operatorEndpoint ? { presets: {
          graphql: managedStatus(snapshot, 'graphql', this.operatorEndpoint),
          linear: managedStatus(snapshot, 'linear', this.operatorEndpoint) as Exclude<ReturnType<typeof managedStatus>, 'legacy'>,
        } } : {}) }
        // Without a readable config file there is no change signal, so the read is not reused.
        const stamp = await fileStamp(snapshot.file)
        // A read started before a write cannot repopulate its invalidated cache.
        if (generation === this.listGeneration) {
          if (stamp) this.lists.set(harness, { list: structuredClone(result), file: snapshot.file, stamp, readAt: Date.now() })
          else this.lists.delete(harness)
        }
        return result
      }
      catch (error) { throw qualificationError(error) }
    })
  }
  async plans(principal: ManagementPrincipal, harness: Harness | 'claude') {
    requireAuthorization(principal, 'harnesses:read')
    const result = await this.pool.query<Row>(`select * from harness_mcp_change_plans where harness=$1
      and ($2::boolean or requested_by=$3) order by case when status in ('submitting','uncertain') then 0 when status='pending' then 1 else 2 end,created_at desc limit 50`, [harness, await this.isRoot(principal), principal.id])
    return { items: result.rows.map(projection) }
  }
  private async isRoot(principal: ManagementPrincipal): Promise<boolean> {
    const result = await this.pool.query("select 1 from management_principals where id=$1 and audience='operator' and delegated_from is null and revoked_at is null and expires_at>now()", [principal.id])
    return result.rowCount === 1
  }
  async get(principal: ManagementPrincipal, id: string) {
    requireAuthorization(principal, 'harnesses:read')
    const result = await this.pool.query<Row>('select * from harness_mcp_change_plans where id=$1 and ($2::boolean or requested_by=$3)', [id, await this.isRoot(principal), principal.id])
    if (!result.rows[0]) throw new DomainError('MCP_PLAN_NOT_FOUND', 'This MCP change is unavailable.', 404)
    return projection(result.rows[0])
  }
  async plan(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HarnessMcpPlanInput) {
    return this.createPlan(principal, source, HarnessMcpPlanInputSchema.parse(raw))
  }
  async planManaged(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HarnessMcpManagedInput) {
    const input = HarnessMcpManagedInputSchema.parse(raw)
    assertSupportedHarness(input.harness)
    if (!this.operatorEndpoint) throw new DomainError('MCP_PRESET_UNAVAILABLE', 'Managed MCP presets are unavailable.', 503)
    return this.createPlan(principal, source, { harness: input.harness, commandId: input.commandId,
      expectedRevision: input.expectedRevision, change: 'enabled' in input ? managedEnableChange(input.preset, input.enabled)
        : managedChange(input.preset, input.installed, this.operatorEndpoint) }, input.preset)
  }
  private async createPlan(principal: ManagementPrincipal, source: 'http' | 'mcp', input: HarnessMcpPlanInput,
    managedPreset?: HarnessMcpManagedPreset) {
    requireAuthorization(principal, 'harnesses:update')
    requireAuthorization(principal, 'harnesses:read')
    // Idempotency receipt is checked before probing a potentially changed native installation.
    try { return await this.commands.execute({ principal, source, operation: managedPreset ? 'harness.mcp.managed.plan' : 'harness.mcp.plan', commandId: input.commandId,
      targetKey: `harness-mcp:${input.harness}`, payload: mcpPlanPayload(input, managedPreset),
      perform: async (client) => this.work(async (signal) => {
        const snapshot = await this.adapters[input.harness].read(signal)
        if (input.expectedRevision !== undefined && snapshot.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Native configuration changed. Refresh the list before reviewing this change.', 409)
        if (managedPreset) assertManagedChange(snapshot, input.change, managedPreset, this.operatorEndpoint!)
        else assertChange(snapshot, input.change)
        const pending = await client.query("select 1 from harness_mcp_change_plans where harness=$1 and host_ref is null and status in ('pending','submitting','uncertain') and (status <> 'pending' or expires_at>now()) limit 100", [input.harness])
        if (pending.rowCount && pending.rowCount >= 100) throw new DomainError('MCP_PLAN_LIMIT', 'Resolve existing MCP changes before adding more.', 409)
        const inserted = await client.query<Row>(`insert into harness_mcp_change_plans(id,harness,revision,change,requested_by,status,expires_at,managed_preset)
          values($1,$2,$3,$4::jsonb,$5,'pending',now()+interval '10 minutes',$6) returning *`,
        [randomUUID(), input.harness, snapshot.revision, JSON.stringify(input.change), principal.id, managedPreset ?? null])
        return projection(inserted.rows[0]!)
      }),
    }) } catch (error) { throw qualificationError(error) }
  }
  /** Plan and apply one managed preset change in a single command. */
  async applyManaged(principal: ManagementPrincipal, input: HarnessMcpManagedInput, source: 'http' | 'mcp' = 'http'): Promise<HarnessMcpPlan> {
    input = HarnessMcpManagedInputSchema.parse(input)
    if (input.hostRef?.kind === 'device') return this.device().apply(principal, input, source)
    return this.applyPlanned(principal, source, await this.planManaged(principal, source, input))
  }
  /** Plan and apply one native connection change in a single command. */
  async applyChange(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: HarnessMcpPlanInput): Promise<HarnessMcpPlan> {
    return this.applyPlanned(principal, source, await this.plan(principal, source, raw))
  }
  private async applyPlanned(principal: ManagementPrincipal, source: 'http' | 'mcp', plan: { value: HarnessMcpPlan }): Promise<HarnessMcpPlan> {
    assertSupportedHarness(plan.value.harness)
    try { return await this.decide(principal, plan.value.id, true, source) }
    catch (error) {
      // Planning committed. A busy/expired/pre-apply 4xx is not rejection of the
      // original command. Return its accepted identity and current state.
      let accepted: HarnessMcpPlan
      try { accepted = await this.get(principal, plan.value.id) }
      catch { throw new DomainError('MCP_MANAGED_ACCEPTED', 'The MCP plan was accepted, but its current result could not be read. Retain and retry the original command.', 503) }
      return accepted.status === 'pending' ? { ...accepted, error: acceptedPlanMessage(error) } : accepted
    }
  }
  /** The writer still holds a live credential with harnesses:update. Delegated Operator credentials apply changes too:
   * the owner chose no human gate for native MCP installs. */
  private async liveWriter(client: pg.PoolClient, principal: ManagementPrincipal): Promise<void> {
    const active = await client.query<{ grants: ManagementPrincipal['grants']; expires_at: Date }>(
      'select grants,expires_at from management_principals where id=$1 and revoked_at is null and expires_at>now() for share', [principal.id])
    if (!active.rows[0]) throw new DomainError('PRINCIPAL_REVOKED', 'Access is unavailable. Check the local API connection before changing MCP connections.', 401)
    requireAuthorization({ ...principal, grants: active.rows[0].grants, expiresAt: active.rows[0].expires_at.toISOString() }, 'harnesses:update')
  }
  private managed(plan: HarnessMcpPlan): { preset: HarnessMcpManagedPreset; endpoint: string } | undefined {
    if (!plan.managedPreset) return undefined
    if (plan.managedPreset === 'operator' || plan.managedPreset === 'worker') {
      throw new DomainError('MCP_PRESET_RETIRED', 'This request uses a retired Operator/Worker MCP preset. Reject it, then add Foreman Code MCP, which serves every role.', 409)
    }
    if (!this.operatorEndpoint) throw new DomainError('MCP_PRESET_UNAVAILABLE', 'Managed MCP presets are unavailable.', 503)
    return { preset: plan.managedPreset, endpoint: this.operatorEndpoint }
  }
  async decide(principal: ManagementPrincipal, id: string, approve: boolean, source: 'http' | 'mcp' = 'http'): Promise<HarnessMcpPlan> {
    requireAuthorization(principal, 'harnesses:update')
    return this.work(async (signal) => {
      const client = await this.pool.connect()
      let locked = false
      let destroyed = false
      let marked = false
      let adapterEntered = false
      let unlockFile: (() => Promise<void>) | undefined
      let selected: HarnessMcpPlan | undefined
      try {
        await this.liveWriter(client, principal)
        const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext('graphql:harness-mcp-settings')) as locked")
        locked = lock.rows[0]?.locked === true
        if (!locked) throw new DomainError('MCP_SETTINGS_BUSY', 'Another MCP change is being applied.', 409)
        const row = await client.query<Row>(
          'select * from harness_mcp_change_plans where id=$1 and ($2::boolean or requested_by=$3)',
          [id, await this.isRoot(principal), principal.id])
        if (!row.rows[0]) throw new DomainError('MCP_PLAN_NOT_FOUND', 'This MCP change is unavailable.', 404)
        selected = projection(row.rows[0])
        if (selected.hostRef?.kind === 'device') throw new DomainError('MCP_DEVICE_REQUEST', 'Device changes apply directly; use Reconcile for uncertain writes.', 409)
        assertSupportedHarness(selected.harness)
        if (selected.status !== 'pending') return selected // Never replay an uncertain or settled write.
        if (approve && Date.parse(selected.expiresAt) <= Date.now()) throw new DomainError('MCP_PLAN_EXPIRED', 'This review expired. Reject it and prepare a new change.', 409)
        if (approve) {
          await assertNoUnresolvedPluginWrites(client)
          const unsettled = await client.query("select 1 from harness_mcp_change_plans where id<>$1 and host_ref is null and status in ('submitting','uncertain') limit 1", [id])
          if (unsettled.rowCount) throw new DomainError('MCP_RECONCILIATION_REQUIRED', 'An earlier native write is unresolved. Use Reconcile on that request before applying another change.', 409)
        }
        const snapshot = approve ? await this.adapters[selected.harness].read(signal) : undefined
        if (snapshot && snapshot.revision !== selected.revision) throw new DomainError('REVISION_CONFLICT', 'Native configuration changed after this review was prepared. Reject it and prepare a new change.', 409)
        if (snapshot) unlockFile = await lockNativeConfigurationFile(client, snapshot.file)
        const managed = approve ? this.managed(selected) : undefined
        const expected = snapshot ? expectedMcpUserFingerprint(snapshot, selected.change, managed) : null
        const plan = selected
        await withClientTransaction(client, async () => {
          await this.liveWriter(client, principal)
          const updated = await client.query<Row>(`update harness_mcp_change_plans set status=$2,decided_by=$3,error=null,
              native_user_after_hash=$4,native_file=$5
            where id=$1 and status='pending' and ($2='rejected' or expires_at>now()) returning *`,
            [id, approve ? 'submitting' : 'rejected', principal.id, expected, snapshot?.file ?? null])
          if (!updated.rows[0]) throw new DomainError('MCP_PLAN_CHANGED', 'This change is no longer awaiting review.', 409)
          marked = approve
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values($1,$4,'harness.mcp.review',$2,'succeeded',$3::jsonb)`,
            [principal.id, `harness-mcp:${plan.harness}`, JSON.stringify({ planId: id, decision: approve ? 'approve' : 'reject' }), source])
        })
        if (!approve) return this.get(principal, id)
        signal.throwIfAborted()
        adapterEntered = true
        await this.adapters[selected.harness].apply(snapshot!, selected.change, signal, managed)
        await withClientTransaction(client, async () => {
          await client.query("update harness_mcp_change_plans set status='applied',error=null where id=$1 and status='submitting'", [id])
          await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
            values($1,$4,'harness.mcp.apply',$2,'succeeded',$3::jsonb)`, [principal.id, `harness-mcp:${plan.harness}`, JSON.stringify({ planId: id }), source])
        })
        this.notifyChanged()
        return this.get(principal, id)
      } catch (error) {
        if (marked && selected) {
          const notSubmitted = !adapterEntered || error instanceof NativeMcpNotSubmittedError
          const plan = selected
          const status = notSubmitted ? 'pending' : 'uncertain'
          const message = notSubmitted
            ? 'The native write was not attempted. Retry this same review, or reject it and prepare a new change.'
            : 'The native write may have completed. Use Reconcile; this write will not be repeated.'
          await withClientTransaction(client, async () => {
            const updated = await client.query("update harness_mcp_change_plans set status=$2,error=$3 where id=$1 and status='submitting'", [id, status, message])
            if (updated.rowCount) await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
              values($1,$4,'harness.mcp.delivery_recorded',$2,'succeeded',$3::jsonb)`,
              [principal.id, `harness-mcp:${plan.harness}`, JSON.stringify({ planId: id, delivery: notSubmitted ? 'not_submitted' : 'uncertain' }), source])
          })
          this.notifyChanged()
          return this.get(principal, id)
        }
        throw qualificationError(error)
      } finally {
        try { await unlockFile?.() } catch (error) {
          destroyed = true
          ignoreError('db', 'release native configuration file lock', { planId: id })(error)
        }
        if (locked) {
          try { await client.query("select pg_advisory_unlock(hashtext('graphql:harness-mcp-settings'))") }
          catch (error) {
            destroyed = true
            ignoreError('db', 'release harness MCP settings lock', { planId: id })(error)
          }
        }
        client.release(destroyed)
      }
    })
  }

  /** Owner-reviewed settlement. Inspection and process cleanup only: never calls apply(). */
  async reconcile(principal: ManagementPrincipal, raw: HarnessMcpReconcileInput, source: 'http' | 'mcp' = 'http') {
    requireAuthorization(principal, 'harnesses:update')
    requireAuthorization(principal, 'harnesses:read')
    const input = HarnessMcpReconcileInputSchema.parse(raw)
    const plan = await this.get(principal, input.planId)
    if (plan.hostRef?.kind === 'device') return this.device().reconcile(principal, input, plan, source)
    assertSupportedHarness(plan.harness)
    const result = await this.commands.execute({ principal, source, operation: 'harness.mcp.reconcile',
      commandId: input.commandId, targetKey: `harness-mcp:${plan.harness}`, payload: input,
      perform: (client) => this.work(async (signal) => {
        await this.liveWriter(client, principal)
        // Same lock key as decide(). A live native writer must finish cleanup first.
        const lock = await client.query<{ locked: boolean }>("select pg_try_advisory_xact_lock(hashtext('graphql:harness-mcp-settings')) as locked")
        if (lock.rows[0]?.locked !== true) throw new DomainError('MCP_SETTINGS_BUSY', 'A native change is still running. Reconcile after it finishes.', 409)
        const rows = await client.query<Row>('select * from harness_mcp_change_plans where id=$1 for update', [input.planId])
        const row = rows.rows[0]
        if (!row) throw new DomainError('MCP_PLAN_NOT_FOUND', 'This MCP change is unavailable.', 404)
        assertSupportedHarness(row.harness)
        if (!['submitting', 'uncertain'].includes(row.status)) return projection(row)
        // Do not release the blocker while an owned native configuration process
        // could still complete the old write. Unknown cleanup remains a hard error.
        await this.closeProcesses()
        signal.throwIfAborted()
        const snapshot = await this.adapters[row.harness].read(signal)
        if (input.expectedRevision !== undefined && snapshot.revision !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Native configuration changed. Refresh, inspect it, and reconcile again.', 409)
        const matchesExpected = row.native_file === snapshot.file
          && row.native_user_after_hash !== null && row.native_user_after_hash === mcpUserFingerprint(snapshot)
        if (!matchesExpected && !input.acceptObservedState) {
          throw new DomainError('MCP_RECONCILIATION_MISMATCH',
            'The inspected configuration does not prove the intended result. Review it, then explicitly choose to keep the current configuration and close this request without replaying it.', 409)
        }
        await this.liveWriter(client, principal)
        const status = matchesExpected ? 'applied' : 'reconciled'
        const updated = await client.query<Row>(`update harness_mcp_change_plans set status=$2,error=$3,decided_by=$4,
          reconciled_revision=$5 where id=$1 and status in ('submitting','uncertain') returning *`,
          [row.id, status, matchesExpected ? null : 'Current native configuration recorded. Original write delivery remains unknown; this request will not be replayed.',
            principal.id, snapshot.revision])
        if (!updated.rows[0]) throw new DomainError('MCP_PLAN_CHANGED', 'The request changed during reconciliation.', 409)
        await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$4,'harness.mcp.reconciliation_recorded',$2,'succeeded',$3::jsonb)`,
          [principal.id, `harness-mcp:${row.harness}`, JSON.stringify({ planId: row.id, commandId: input.commandId,
            previousStatus: row.status, status, inspectedRevision: snapshot.revision, matchesExpected,
            acceptedObservedState: input.acceptObservedState, nativeWriteRepeated: false }), source])
        return projection(updated.rows[0])
      }),
    })
    this.notifyChanged()
    return result
  }
}
