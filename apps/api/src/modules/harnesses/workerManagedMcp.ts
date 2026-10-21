import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { McpDetectionSchema, type McpDetection } from '@foreman-code/contracts'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { MANAGED_MCP_NAMESPACE, ManagedMcpFailureSchema, ManagedMcpRequestSchema }
  from '@foreman-code/contracts/managed-mcp-channel'
import { HarnessMcpPlanSchema, type HarnessMcpManagedInput, type HarnessMcpPlan, type HarnessMcpReconcileInput }
  from '@foreman-code/contracts/management'
import { syncNativeConfigDirectory } from './nativeConfigFiles.js'
import { appMcpNeedsMigration, assertManagedChange, expectedMcpUserFingerprint, fingerprint, managedChange, managedEnableChange,
  managedStatus, mcpUserFingerprint, publicMcpList, record, type NativeMcpAdapter } from './nativeMcpCommon.js'
import { APP_MCP_SERVER_NAME, appLauncherTokenName } from './appMcpLauncher.js'
import { DomainError } from '../errors.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { errorMessage } from '../../shared/errorMessage.js'

type Harness = 'codex' | 'claude'
const RecordSchema = z.object({ hash: z.string(), plan: HarnessMcpPlanSchema, expectedHash: z.string() }).strict()

/** The paired Worker owns native files and retains delivery state across Main retries and Worker restarts. */
export class WorkerManagedMcp {
  private active: Promise<unknown> = Promise.resolve()
  constructor(private readonly options: {
    directory: string
    adapters: Record<Harness, NativeMcpAdapter>
    installLauncher(signal: AbortSignal): Promise<void>
    prepare?: (harness: Harness) => Promise<void>
    inspect?: (harness: Harness, signal: AbortSignal) => Promise<McpDetection>
  }) {}

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const task = this.active.then(work, work)
    this.active = task
    return task
  }
  get workingDirectory(): string { return this.options.directory }
  private path(key: string) { return join(this.options.directory, 'managed-mcp', `${fingerprint(key).slice(7)}.json`) }
  private async read(key: string) {
    try { return RecordSchema.parse(JSON.parse(await readFile(this.path(key), 'utf8'))) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  private async save(key: string, record: z.infer<typeof RecordSchema>) {
    const file = this.path(key)
    await mkdir(join(this.options.directory, 'managed-mcp'), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}`
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(record)); await handle.sync() }
    finally { await handle.close() }
    await rename(temporary, file)
    await syncNativeConfigDirectory(file)
  }
  async list(harness: Harness, signal: AbortSignal) {
    const snapshot = await this.options.adapters[harness].read(signal)
    return { ...publicMcpList(snapshot), presets: { graphql: managedStatus(snapshot, 'graphql'),
      linear: managedStatus(snapshot, 'linear') as Exclude<ReturnType<typeof managedStatus>, 'legacy'> } }
  }
  async detect(harness: Harness, signal: AbortSignal): Promise<McpDetection> {
    if (this.options.inspect) return McpDetectionSchema.parse(await this.options.inspect(harness, signal))
    const snapshot = await this.options.adapters[harness].read(signal)
    const status = managedStatus(snapshot, 'graphql')
    const name = APP_MCP_SERVER_NAMES.find(server => Object.hasOwn(snapshot.user, server)
      || Object.hasOwn(snapshot.effective, server)) ?? APP_MCP_SERVER_NAME
    const entry = record(snapshot.effective[name] ?? snapshot.user[name])
    const states = { missing: 'not_detected', installed: 'status_unavailable', disabled: 'disabled',
      mismatch: 'misconfigured', inherited: 'misconfigured', legacy: 'misconfigured' } as const
    return McpDetectionSchema.parse({ harness, serverName: name, state: states[status],
      endpointMatches: status === 'installed' || status === 'disabled',
      credentialEnvironmentVariable: status === 'installed' || status === 'disabled' ? appLauncherTokenName(entry) : null,
      checkedAt: new Date().toISOString(), detail: 'Native user configuration inspected on this computer.' })
  }
  apply(input: HarnessMcpManagedInput, requestedBy: string, signal: AbortSignal,
    assertCurrent: () => void = () => {}): Promise<HarnessMcpPlan> {
    return this.serialize(() => this.applyOnce(input, requestedBy, signal, assertCurrent))
  }
  private async applyOnce(input: HarnessMcpManagedInput, requestedBy: string, signal: AbortSignal,
    assertCurrent: () => void): Promise<HarnessMcpPlan> {
    if (input.preset !== 'graphql') throw new DomainError('MCP_PRESET_UNAVAILABLE', 'Paired devices manage Foreman Code MCP only.', 409)
    const key = `${requestedBy}:${input.harness}:${input.commandId}`
    const hash = fingerprint(input)
    const previous = await this.read(key)
    if (previous) {
      if (previous.hash !== hash) throw new DomainError('COMMAND_ID_CONFLICT', 'This command has different input.', 409)
      if (previous.plan.status === 'submitting') {
        previous.plan.status = 'uncertain'
        previous.plan.error = 'Worker stopped during this change. Reconcile before requesting another write.'
        await this.save(key, previous)
      }
      return previous.plan
    }
    const blocker = await this.read(`active:${input.harness}`)
    if (blocker && ['submitting', 'uncertain'].includes(blocker.plan.status)) {
      throw new DomainError('MCP_RECONCILIATION_REQUIRED', 'Reconcile the earlier device MCP write before changing it.', 409)
    }
    await this.options.prepare?.(input.harness)
    const adapter = this.options.adapters[input.harness]
    const snapshot = await adapter.read(signal)
    if (input.expectedRevision !== undefined && snapshot.revision !== input.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 'Native configuration changed. Refresh before changing it.', 409)
    }
    const change = 'enabled' in input ? managedEnableChange(input.preset, input.enabled)
      : managedChange(input.preset, input.installed, '')
    const managed = { preset: input.preset, endpoint: 'https://app.invalid/mcp' }
    assertManagedChange(snapshot, change, input.preset, managed.endpoint)
    const expectedHash = expectedMcpUserFingerprint(snapshot, change, managed)
    const plan = HarnessMcpPlanSchema.parse({ id: randomUUID(), harness: input.harness, hostRef: input.hostRef,
      managedPreset: input.preset, revision: snapshot.revision, change, requestedBy, status: 'submitting', error: null,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() })
    assertCurrent()
    signal.throwIfAborted()
    await this.save(key, { hash, plan, expectedHash })
    await this.save(plan.id, { hash: key, plan, expectedHash })
    await this.save(`active:${input.harness}`, { hash: key, plan, expectedHash })
    try {
      if (change.kind === 'add') await this.options.installLauncher(signal)
      assertCurrent()
      signal.throwIfAborted()
      await adapter.apply(snapshot, change, signal, managed)
      const after = await adapter.read(signal)
      if (mcpUserFingerprint(after) !== expectedHash) throw new DomainError('MCP_WRITE_UNCONFIRMED', 'Native write was not confirmed.', 409)
      plan.status = 'applied'
    } catch {
      plan.status = 'uncertain'
      plan.error = 'The native write may have completed. Reconcile this request; it will not be repeated.'
    }
    await this.save(key, { hash, plan, expectedHash })
    await this.save(plan.id, { hash: key, plan, expectedHash })
    await this.save(`active:${input.harness}`, { hash: key, plan, expectedHash })
    return plan
  }
  reconcile(input: HarnessMcpReconcileInput, plan: HarnessMcpPlan, signal: AbortSignal): Promise<HarnessMcpPlan> {
    return this.serialize(async () => {
      const record = await this.read(plan.id)
      if (!record || record.plan.requestedBy !== plan.requestedBy) throw new DomainError('MCP_PLAN_NOT_FOUND', 'MCP change unavailable.', 404)
      if (!['submitting', 'uncertain'].includes(record.plan.status)) return record.plan
      if (record.plan.harness === 'opencode') throw new DomainError('HARNESS_RETIRED', 'Harness retired.', 409)
      const snapshot = await this.options.adapters[record.plan.harness].read(signal)
      if (input.expectedRevision !== undefined && snapshot.revision !== input.expectedRevision) {
        throw new DomainError('REVISION_CONFLICT', 'Native configuration changed.', 409)
      }
      const matches = mcpUserFingerprint(snapshot) === record.expectedHash
      if (!matches && !input.acceptObservedState) throw new DomainError('MCP_RECONCILIATION_MISMATCH', 'The native result does not match the request.', 409)
      record.plan.status = matches ? 'applied' : 'reconciled'
      record.plan.error = null
      const command = await this.read(record.hash)
      if (!command) throw new DomainError('MCP_PLAN_NOT_FOUND', 'MCP retry record unavailable.', 404)
      await this.save(record.hash, { ...command, plan: record.plan })
      await this.save(plan.id, record)
      await this.save(`active:${record.plan.harness}`, record)
      return record.plan
    })
  }
  /** Pairing approves managed setup; explicit disabled or customized connections retain their policy. */
  ensureReady(harnesses: readonly Harness[], options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.serialize(() => this.installReady(harnesses, options))
  }
  private async installReady(harnesses: readonly Harness[], options: { signal?: AbortSignal }): Promise<void> {
    const deadline = AbortSignal.timeout(120_000)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    await this.options.installLauncher(signal)
    const failures: unknown[] = []
    for (const harness of harnesses) {
      try {
        await this.options.prepare?.(harness)
        const snapshot = await this.options.adapters[harness].read(signal)
        const status = managedStatus(snapshot, 'graphql')
        const migrate = appMcpNeedsMigration(snapshot)
        if ((status === 'installed' || status === 'disabled') && !migrate) continue
        if (status !== 'missing' && status !== 'legacy' && !migrate) {
          throw new DomainError('APP_MCP_SETUP_FAILED',
            'Foreman Code MCP has custom or inherited configuration. Inspect its native connection settings.', 409)
        }
        const result = await this.applyOnce({ harness, preset: 'graphql', installed: true,
          commandId: `ready-${randomUUID()}`, expectedRevision: snapshot.revision },
        'paired-device', signal, () => signal.throwIfAborted())
        if (result.status !== 'applied') throw new DomainError('APP_MCP_SETUP_FAILED', result.error ?? 'Managed MCP setup failed.', 409)
      } catch (error) {
        signal.throwIfAborted()
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Managed MCP setup failed for multiple harnesses.')
  }
}

export function createWorkerManagedMcpExtension(worker: WorkerManagedMcp,
  current: () => Readonly<DeviceSessionBinding>): DeviceExtensionRegistration {
  return { namespace: MANAGED_MCP_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      const { target, request } = ManagedMcpRequestSchema.parse(payload)
      const assertCurrent = () => {
        context.signal.throwIfAborted()
        context.connectionSignal?.throwIfAborted()
        const binding = context.binding
        if (context.bytes !== undefined || !isDeepStrictEqual(current(), binding)
          || target.hostRef.kind !== 'device' || target.hostRef.mainId !== binding.mainId
          || target.hostRef.deviceId !== binding.deviceId || target.applicationInstallationId !== binding.workerInstallationId
          || target.keyRevision !== binding.keyRevision || target.authorizationRevision !== binding.authorizationRevision) {
          throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'MCP management requires the current paired computer.', 409)
        }
      }
      assertCurrent()
      const signal = context.connectionSignal ? AbortSignal.any([context.signal, context.connectionSignal]) : context.signal
      let result: unknown
      try {
        if (request.operation === 'list') result = await worker.list(request.harness, signal)
        else if (request.operation === 'detect') result = { detection: await worker.detect(request.harness, signal),
          runnerId: context.binding.deviceId, workingDirectory: worker.workingDirectory, providerVersion: 'unknown', nativeFilters: {} }
        else if (request.operation === 'reconcile') result = await worker.reconcile(request.input, request.plan, signal)
        else {
          if (request.input.hostRef && !isDeepStrictEqual(request.input.hostRef, target.hostRef)) {
            throw new DomainError('MCP_INSPECTION_CONTEXT_MISMATCH', 'The requested MCP computer changed.', 409)
          }
          result = await worker.apply(request.input, request.requestedBy, signal, assertCurrent)
        }
      } catch (error) {
        assertCurrent()
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code : 'MCP_OPERATION_FAILED'
        return { payload: ManagedMcpFailureSchema.parse({ error: { code,
          message: errorMessage(error, 'The Worker could not complete the native MCP operation.'),
          status: error instanceof DomainError ? error.status : 503 } }) }
      }
      assertCurrent()
      return { payload: result }
    } }
}
