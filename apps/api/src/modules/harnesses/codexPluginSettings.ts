import type pg from 'pg'
import { withClientTransaction } from '../../infrastructure/transaction.js'
import { z } from 'zod'
import {
  CodexPluginChangeInputSchema, CodexPluginChangeResultSchema, CodexPluginDetailResultSchema,
  CodexPluginGetInputSchema, CodexPluginListInputSchema, CodexPluginListResultSchema,
  CodexPluginOperationsResultSchema, CodexPluginReconcileInputSchema,
  type CodexPluginChangeInput, type CodexPluginChangeResult, type CodexPluginListInput,
  type CodexPluginReconcileInput, type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { CodexPluginAdapter, CodexPluginCatalog, CodexPluginMutation } from './codexPlugins.js'
import { pluginConfigurationHas, unrelatedPluginConfiguration } from './codexPluginCatalog.js'
import { PluginReadQueue } from './pluginReadQueue.js'
import { QualificationCache } from './qualificationCache.js'
import { assertNoUnresolvedMcpWrites, assertNoUnresolvedPluginWrites, lockNativeConfigurationFile, NATIVE_SETTINGS_LOCK } from './nativeSettingsWrites.js'
import { ignoreError, logIgnoredError } from '../diagnostics/ignoredError.js'

const operation = 'codex.plugin.change'
const RecoverySchema = z.object({
  writerIdentity: z.string().min(1), format: z.literal(1), input: CodexPluginChangeInputSchema, unrelatedHash: z.string(),
  sourceIdentity: z.string(), version: z.string().nullable(), sourceType: z.string(),
  acknowledged: z.boolean(), mutationVersion: z.string().nullable(),
}).strict()
type Recovery = z.infer<typeof RecoverySchema>
type ReceiptRow = { principal_id: string; command_id: string; input_hash: string; target_key: string; result: unknown }
function stored(row: ReceiptRow): { result: CodexPluginChangeResult; recovery?: Recovery } {
  const value = row.result as Record<string, unknown>
  const { _recovery, ...publicResult } = value
  const recovery = RecoverySchema.safeParse(_recovery)
  return { result: CodexPluginChangeResultSchema.parse(publicResult), ...(recovery.success ? { recovery: recovery.data } : {}) }
}
const message = 'The native change may have happened. Reconcile this original request; Refresh does not settle it.'
const safeCode = (error: unknown) => error instanceof DomainError ? error.code : 'CODEX_PLUGIN_NATIVE_UNCONFIRMED'

/** Receipts are write fences, not a replacement for native state. Reconciliation never invokes change(). */
export class CodexPluginSettingsService {
  private readonly stopping = new AbortController()
  private readonly queue = new PluginReadQueue()
  private readonly catalogs = new QualificationCache<CodexPluginCatalog>(30_000, 2, Date.now, true)
  constructor(private readonly pool: pg.Pool, private readonly adapter: CodexPluginAdapter,
    private readonly closeProcesses: () => Promise<unknown> = async () => undefined) {}
  private signal(request?: AbortSignal) {
    return AbortSignal.any([this.stopping.signal, AbortSignal.timeout(60_000), ...(request ? [request] : [])])
  }
  /** The writer still holds a live credential with plugin update rights. Delegated Operator credentials install and
   * remove plugins too: the owner chose no human gate for plugin installs. */
  private async liveOwner(principal: ManagementPrincipal, client: pg.Pool | pg.PoolClient = this.pool): Promise<void> {
    const result = await client.query<{ grants: ManagementPrincipal['grants']; expires_at: Date }>(
      'select grants,expires_at from management_principals where id=$1 and revoked_at is null and expires_at>now()', [principal.id])
    if (!result.rows[0]) throw new DomainError('PRINCIPAL_REVOKED', 'Access is unavailable. Check the local API connection before changing plugins.', 401)
    const current = { ...principal, grants: result.rows[0].grants, expiresAt: result.rows[0].expires_at.toISOString() }
    requireAuthorization(current, 'harnesses:update')
    requireAuthorization(current, 'harnesses:read')
  }
  private catalog(options: { signal: AbortSignal; refresh?: boolean | undefined }) {
    // Reads reuse a recent catalog and refresh it in the background; writes read natively and clear it.
    return this.catalogs.get('catalog', (signal) => this.queue.run('catalog',
      (active) => this.adapter.list(active), this.signal(signal)), options)
      .catch((error: unknown) => { this.catalogs.forget('catalog'); throw error })
  }
  /** Fill the catalog before Settings opens. */
  async warmup(): Promise<void> {
    try { await this.catalog({ signal: this.signal() }) }
    catch (error) { logIgnoredError('harness', 'warm Codex plugin catalog', error); throw error }
  }
  async list(principal: ManagementPrincipal, raw: CodexPluginListInput, request?: AbortSignal) {
    requireAuthorization(principal, 'harnesses:read')
    const input = CodexPluginListInputSchema.parse(raw)
    const catalog = await this.catalog({ signal: this.signal(request), refresh: input.refresh })
    const query = input.query.toLocaleLowerCase()
    const items = catalog[input.view].filter((plugin) => !query || `${plugin.name} ${plugin.marketplaceName}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name) || a.marketplaceName.localeCompare(b.marketplaceName))
    return CodexPluginListResultSchema.parse({ items: items.slice(input.offset, input.offset + input.limit), total: items.length,
      nextOffset: input.offset + input.limit < items.length ? input.offset + input.limit : null,
      revision: catalog.revision, checkedAt: new Date().toISOString(), catalogStatus: catalog.catalogStatus, inventoryStatus: catalog.inventoryStatus })
  }
  async get(principal: ManagementPrincipal, pluginId: string,
    options: { signal?: AbortSignal; refresh?: boolean | undefined } = {}) {
    requireAuthorization(principal, 'harnesses:read')
    const { pluginId: id } = CodexPluginGetInputSchema.parse({ pluginId })
    const signal = this.signal(options.signal)
    const catalog = await this.catalog({ signal, refresh: options.refresh })
    const plugin = [...catalog.installed, ...catalog.available].find((item) => item.pluginId === id)
    if (!plugin) throw new DomainError('CODEX_PLUGIN_NOT_FOUND', 'This plugin has no inspectable Codex record.', 404)
    const contents = await this.queue.run(undefined, (active) => this.adapter.detail(plugin, active), signal)
    return CodexPluginDetailResultSchema.parse({ plugin, contents, revision: catalog.revision, artifactIdentity: catalog.evidence[id]!.artifactIdentity })
  }
  async operations(principal: ManagementPrincipal) {
    await this.liveOwner(principal)
    const rows = await this.pool.query<ReceiptRow>(`select principal_id,command_id,input_hash,target_key,result
      from management_command_receipts where operation=$1 and result->>'status'='uncertain' order by command_id limit 100`, [operation])
    return CodexPluginOperationsResultSchema.parse({ items: rows.rows.map((row) => {
      const receipt = stored(row)
      return { requestedBy: row.principal_id, commandId: row.command_id, input: receipt.recovery?.input ?? null, result: receipt.result }
    }) })
  }
  async recover(): Promise<void> {
    // Startup runs under runtime ownership, before accepting writes. Never replay receipts.
    await this.closeProcesses()
  }
  async shutdown(): Promise<void> {
    this.stopping.abort()
    await this.queue.drain()
    await this.closeProcesses()
  }
  private async locked<T>(principal: ManagementPrincipal, work: (client: pg.PoolClient, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const client = await this.pool.connect()
    const lost = new AbortController()
    let locked = false
    let destroyed = false
    const onLost = (error: Error) => { destroyed = true; lost.abort(error) }
    client.on('error', onLost)
    try {
      await this.liveOwner(principal, client)
      const result = await client.query<{ locked: boolean }>('select pg_try_advisory_lock(hashtext($1)) as locked', [NATIVE_SETTINGS_LOCK])
      locked = result.rows[0]?.locked === true
      if (!locked) throw new DomainError('MCP_SETTINGS_BUSY', 'Another native settings change is in progress. Retry the original request.', 409)
      return await work(client, AbortSignal.any([signal, lost.signal]))
    } catch (error) { destroyed = true; throw error } finally {
      if (locked) {
        try { await client.query('select pg_advisory_unlock(hashtext($1))', [NATIVE_SETTINGS_LOCK]) }
        catch { destroyed = true }
      }
      client.removeListener('error', onLost)
      client.release(destroyed)
    }
  }
  private async save(source: 'http' | 'mcp', client: pg.PoolClient, principal: ManagementPrincipal, row: Pick<ReceiptRow, 'principal_id' | 'command_id'>,
    result: CodexPluginChangeResult, recovery: Recovery, action: string, insert = false): Promise<void> {
    await withClientTransaction(client, async () => {
      await this.liveOwner(principal, client)
      const value = JSON.stringify({ ...result, _recovery: recovery })
      if (insert) await client.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
        values($1,$2,$3,$4,$5,$6::jsonb)`, [row.principal_id, operation, row.command_id, `codex-plugin:${result.pluginId}`, commandInputHash(recovery.input), value])
      else await client.query(`update management_command_receipts set result=$4::jsonb where principal_id=$1 and operation=$2 and command_id=$3`,
        [row.principal_id, operation, row.command_id, value])
      await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,$6,$2,$3,$4,$5::jsonb)`, [principal.id, action, `codex-plugin:${result.pluginId}`,
        result.status === 'uncertain' ? 'uncertain' : result.status === 'not_applied' ? 'failed' : 'succeeded',
        JSON.stringify({ commandId: row.command_id, requestedBy: row.principal_id, status: result.status,
          nativeFailure: result.nativeFailure ?? null, nativeWriteRepeated: false }), source])
    })
  }
  change(principal: ManagementPrincipal, raw: CodexPluginChangeInput, source: 'http' | 'mcp' = 'http') {
    return this.afterWrite(this.changeNative(principal, raw, source))
  }
  private afterWrite<T>(write: Promise<T>): Promise<T> {
    // Settled, failed or uncertain, a write may have changed native state.
    return write.finally(() => this.catalogs.clear())
  }
  private changeNative(principal: ManagementPrincipal, raw: CodexPluginChangeInput, source: 'http' | 'mcp') {
    requireAuthorization(principal, 'harnesses:update')
    requireAuthorization(principal, 'harnesses:read')
    const input = CodexPluginChangeInputSchema.parse(raw)
    // HTTP disconnection must not cancel a write after its durable receipt was accepted.
    return this.queue.run(undefined, (signal) => this.locked(principal, async (client, active) => {
      const existing = await client.query<ReceiptRow>(`select principal_id,command_id,input_hash,target_key,result
        from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3`, [principal.id, operation, input.commandId])
      const row = existing.rows[0]
      if (row) {
        if (row.input_hash !== commandInputHash(input) || row.target_key !== `codex-plugin:${input.pluginId}`)
          throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.', 409)
        return stored(row).result // Same ID never repeats a native command, even after restart.
      }
      if (!input.artifactIdentity) throw new DomainError('CODEX_PLUGIN_REVIEW_REQUIRED', 'Review the plugin details before creating a new change.', 409)
      if (!this.adapter.recoveryIdentity) throw new DomainError('CODEX_PLUGIN_RECOVERY_UNAVAILABLE', 'Persistent native writer recovery is unavailable on this installation.', 503)
      await assertNoUnresolvedMcpWrites(client)
      await assertNoUnresolvedPluginWrites(client)
      const before = await this.adapter.list(active)
      if (before.revision !== input.expectedRevision || before.evidence[input.pluginId]?.artifactIdentity !== input.artifactIdentity)
        throw new DomainError('REVISION_CONFLICT', 'The plugin source or native configuration changed. Review refreshed details before a new change.', 409)
      const plugin = [...before.installed, ...before.available].find((item) => item.pluginId === input.pluginId)
      if (!plugin) throw new DomainError('CODEX_PLUGIN_NOT_FOUND', 'This plugin has no inspectable Codex record.', 404)
      if (plugin.verification === 'unverified' || plugin.unavailableReason)
        throw new DomainError('CODEX_PLUGIN_UNVERIFIED', plugin.unavailableReason ?? 'Codex must verify this plugin before a write.', 409)
      if (input.action === 'install' && (plugin.installed || plugin.installPolicy !== 'AVAILABLE' || before.catalogStatus !== 'complete'))
        throw new DomainError('CODEX_PLUGIN_INSTALL_UNAVAILABLE', 'Codex does not offer a verified, unambiguous installation.', 409)
      if (input.action === 'remove' && (!plugin.installed || plugin.installPolicy === 'INSTALLED_BY_DEFAULT'))
        throw new DomainError('CODEX_PLUGIN_REMOVE_UNAVAILABLE', 'This plugin cannot be removed here.', 409)
      if (before.configuration.verified === false) throw new DomainError('CODEX_PLUGIN_CONFIG_UNAVAILABLE', 'Codex user configuration could not be verified.', 409)
      const unlockFile = await lockNativeConfigurationFile(client, before.configuration.file)
      try {
        const result: CodexPluginChangeResult = { pluginId: input.pluginId, action: input.action, status: 'uncertain', message }
        const recovery: Recovery = { writerIdentity: this.adapter.recoveryIdentity, format: 1, input, unrelatedHash: unrelatedPluginConfiguration(before.configuration, input.pluginId),
          sourceIdentity: before.evidence[input.pluginId]!.sourceIdentity, version: plugin.version, sourceType: plugin.sourceType,
          acknowledged: false, mutationVersion: null }
        const owner = { principal_id: principal.id, command_id: input.commandId }
        await this.save(source, client, principal, owner, result, recovery, operation, true)
        let mutation: CodexPluginMutation | undefined
        try {
          await this.liveOwner(principal, client)
          active.throwIfAborted()
          mutation = await this.adapter.change(input.pluginId, input.action, active, before)
          recovery.acknowledged = mutation.acknowledged
          recovery.mutationVersion = mutation.version
        } catch (error) { result.nativeFailure = safeCode(error) }
        // Persist native failure/acknowledgement before attempting another potentially failing read.
        await this.save(source, client, principal, owner, result, recovery, 'codex.plugin.native_result')
        try {
          await this.closeProcesses()
          const after = await this.adapter.list(active)
          if (mutation && this.desired(after, recovery)) {
            result.status = 'applied'
            result.message = input.action === 'install' ? 'Installed in Codex. New sessions use the updated bundle.'
              : 'Removed from Codex. Separately configured MCP connections were preserved.'
          }
        } catch (error) { result.nativeFailure ??= safeCode(error) }
        await this.save(source, client, principal, owner, result, recovery, 'codex.plugin.readback')
        return CodexPluginChangeResultSchema.parse(result)
      } finally { await unlockFile() }
    }, signal), this.signal()).catch(async (error: unknown) => {
      await this.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
        values($1,$4,'codex.plugin.change',$2,'failed',$3::jsonb)`, [principal.id, `codex-plugin:${input.pluginId}`,
        JSON.stringify({ commandId: input.commandId, code: safeCode(error) }), source])
        .catch(ignoreError('harness', 'record failed Codex plugin change audit', { commandId: input.commandId, pluginId: input.pluginId }))
      throw error
    })
  }
  private desired(catalog: CodexPluginCatalog, recovery: Recovery): boolean {
    const { input } = recovery
    if (catalog.configuration.verified === false) return false
    if (unrelatedPluginConfiguration(catalog.configuration, input.pluginId) !== recovery.unrelatedHash) return false
    const installed = catalog.installed.find((item) => item.pluginId === input.pluginId)
    if (input.action === 'remove') {
      // A validated native remove result is authoritative; catalog absence by itself never is.
      return recovery.acknowledged && !installed && !pluginConfigurationHas(catalog.configuration, input.pluginId)
    }
    return Boolean(installed && installed.verification !== 'unverified' && !installed.unavailableReason
      && catalog.evidence[input.pluginId]?.sourceIdentity === recovery.sourceIdentity
      && (recovery.version === null || installed.version === recovery.version)
      && (recovery.mutationVersion === null || installed.version === recovery.mutationVersion))
  }
  reconcile(principal: ManagementPrincipal, raw: CodexPluginReconcileInput, source: 'http' | 'mcp' = 'http') {
    return this.afterWrite(this.reconcileNative(principal, raw, source))
  }
  private reconcileNative(principal: ManagementPrincipal, raw: CodexPluginReconcileInput, source: 'http' | 'mcp') {
    requireAuthorization(principal, 'harnesses:update')
    requireAuthorization(principal, 'harnesses:read')
    const input = CodexPluginReconcileInputSchema.parse(raw)
    return this.queue.run(undefined, (signal) => this.locked(principal, async (client, active) => {
      const rows = await client.query<ReceiptRow>(`select principal_id,command_id,input_hash,target_key,result
        from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3`,
        [input.requestedBy ?? principal.id, operation, input.commandId])
      const row = rows.rows[0]
      if (!row) throw new DomainError('CODEX_PLUGIN_OPERATION_NOT_FOUND', 'The original plugin operation was not found. Retry its exact original request.', 404)
      const { result, recovery } = stored(row)
      if (result.status !== 'uncertain') return result
      // Empty new recovery storage does not prove that a pre-upgrade writer is gone.
      if (!recovery) throw new DomainError('CODEX_PLUGIN_LEGACY_RECOVERY_REQUIRED', 'This older write has no persistent process ownership evidence. Complete native process recovery before manually settling it.', 409)
      if (recovery.writerIdentity !== this.adapter.recoveryIdentity) throw new DomainError('CODEX_PLUGIN_RECOVERY_SCOPE_CHANGED', 'The native process recovery location changed. Restore the original recovery scope before settling this request.', 409)
      await this.closeProcesses()
      active.throwIfAborted()
      const catalog = await this.adapter.list(active)
      if (input.expectedRevision && input.expectedRevision !== catalog.revision)
        throw new DomainError('REVISION_CONFLICT', 'Native state changed during reconciliation. Inspect the current state again.', 409)
      if (this.desired(catalog, recovery)) {
        result.status = 'applied'; result.message = 'The intended plugin state was verified. The original native write was not repeated.'
      } else if (input.acceptObservedState) {
        // Explicit closure, NOT a success claim about the original install/remove.
        result.status = 'reconciled'; result.message = 'Current native state retained. Original write delivery remains unknown; it will not be replayed.'
      } else {
        result.message = 'Process cleanup completed, but the intended result is not proven. Inspect current state, then explicitly keep it or reconcile again.'
        result.observedRevision = catalog.revision
      }
      await this.save(source, client, principal, row, result, recovery, 'codex.plugin.reconcile')
      return CodexPluginChangeResultSchema.parse(result)
    }, signal), this.signal())
  }
}
