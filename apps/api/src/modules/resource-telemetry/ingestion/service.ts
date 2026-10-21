import { createHash, randomUUID } from 'node:crypto'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  RESOURCE_TELEMETRY_CAPABILITY, TELEMETRY_LIMITS, TelemetryCollectedBatchSchema, TelemetryHostSchema,
  TelemetrySelectorSchema, TelemetrySelectorTargetSchema, telemetryCanonical, telemetrySelectorKey,
  type CollectionChallenge, type TelemetryCollectedBatch, type TelemetryCollectedRow, type TelemetryCpu,
  type TelemetryHost, type TelemetryIdentity, type TelemetryOwner, type TelemetryReason, type TelemetryReadResult, type TelemetrySample, type TelemetrySelector,
  type TelemetrySelectorResult, type TelemetrySelectorTarget,
  type TrustedTelemetryContext, type TelemetryReadService,
} from '@foreman-code/contracts/resource-telemetry'
import type { TelemetryOwnedTargetFacts, TelemetryTargetAuthority } from './ports.js'
import type { TelemetryClock, TelemetryOwnershipReader, TelemetryOwnershipView, TelemetryReadAuthority, TelemetrySessionReader } from './ports.js'

export type IngestReceipt = { status: 'accepted' | 'duplicate'; sampleId: string; gaps: string }
interface CachedRow { latest: TelemetrySample; lastKnown: TelemetrySample | null; issuedMonoMs: number;
  sharedOwners: readonly TelemetryOwner[] | null; lastKnownSharedOwners: readonly TelemetryOwner[] | null;
  storedMonoMs: number; lastKnownMonoMs: number; logicalCpuCount: number; contextKey: string; capture: TelemetryCollectedRow; captureStart: bigint; captureEnd: bigint }
interface RowTombstone { reason: TelemetryReason; storedMonoMs: number }
type RetainedRow = CachedRow | RowTombstone
interface DeviceState { context: TrustedTelemetryContext; identity: TelemetryIdentity; key: string; retired: boolean;
  challenges: Map<string, { monoMs: number; challenge: CollectionChallenge }>; lastIssued: number;
  sequence: bigint | null; digest: string | null; receipt: IngestReceipt | null; queued: number; tail: Promise<void>; abort: AbortController;
  rows: Map<string, RetainedRow> }
export class TelemetryRejected extends Error { constructor(readonly reason: string, options?: ErrorOptions) { super(`Telemetry rejected: ${reason}`, options) } }
const contextKey = (context: TrustedTelemetryContext) => telemetryCanonical(context)
const digest = (value: unknown) => createHash('sha256').update(telemetryCanonical(value)).digest('hex')
const identityKey = (identity: TelemetryIdentity) => telemetryCanonical(identity)
/** No transport, database, collector start or execution mutation lives in this service. */
export class ResourceTelemetryService implements TelemetryReadService<ManagementPrincipal> {
  readonly #devices = new Map<string, DeviceState>()
  readonly #pending = new Set<Promise<void>>()
  readonly #listeners = new Set<() => void>()
  #closed = false
  constructor(readonly ports: { clock: TelemetryClock; sessions: TelemetrySessionReader;
    ownership: TelemetryOwnershipReader; reads: TelemetryReadAuthority }) {}

  #identity(context: TrustedTelemetryContext, collectorGeneration: string): TelemetryIdentity {
    if (context.capability !== RESOURCE_TELEMETRY_CAPABILITY) throw new TelemetryRejected('capability')
    if (context.kind === 'main-local') return { mainId: context.mainId, host: TelemetryHostSchema.parse({
      hostRef: { kind: 'main', mainId: context.mainId }, deviceId: context.deviceId,
      applicationInstallationId: context.applicationInstallationId, bootId: context.bootId, runtimeEpoch: context.runtimeEpoch,
      keyRevision: null, authorizationRevision: null, connectionGeneration: null, collectorGeneration }) }
    const b = context.binding
    return { mainId: b.mainId, host: TelemetryHostSchema.parse({ hostRef: { kind: 'device', mainId: b.mainId, deviceId: b.deviceId },
      deviceId: b.deviceId, applicationInstallationId: b.workerInstallationId, bootId: b.bootId, runtimeEpoch: b.connectionEpoch,
      keyRevision: b.keyRevision, authorizationRevision: b.authorizationRevision, connectionGeneration: b.connectionGeneration, collectorGeneration }) }
  }
  #notify(): void { for (const wake of this.#listeners) wake() }
  #device(context: TrustedTelemetryContext): DeviceState {
    const state = this.#devices.get(contextKey(context))
    if (!state || state.retired || this.#closed) throw new TelemetryRejected('session-generation')
    return state
  }
  async #active(state: DeviceState, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (state.retired || this.#closed || !await this.ports.sessions.active(state.context, signal)) {
      this.revoke(state.context)
      throw new TelemetryRejected('authorization')
    }
    signal.throwIfAborted()
    if (state.retired || this.#devices.get(state.key) !== state) throw new TelemetryRejected('session-generation')
  }
  /** Called only by authenticated W07 generation reset or trusted HRT runtime initialization. */
  async handshake(context: TrustedTelemetryContext, collectorGeneration: string, signal: AbortSignal): Promise<TelemetryIdentity> {
    const identity = this.#identity(context, collectorGeneration)
    if (this.#closed || !await this.ports.sessions.active(context, signal)) throw new TelemetryRejected('authorization')
    signal.throwIfAborted()
    const key = contextKey(context)
    const previous = this.#devices.get(key)
    if (previous && identityKey(previous.identity) === identityKey(identity)) return structuredClone(identity)
    // One latest collector per physical device; reconnect fences all old callbacks/cache.
    for (const state of this.#devices.values()) if (state.identity.mainId === identity.mainId && state.identity.host.deviceId === identity.host.deviceId) this.revoke(state.context)
    if (this.#devices.size >= TELEMETRY_LIMITS.devices) throw new TelemetryRejected('device-limit')
    this.#devices.set(key, { context: structuredClone(context), identity, key, retired: false, challenges: new Map(),
      lastIssued: -Infinity, sequence: null, digest: null, receipt: null, queued: 0, tail: Promise.resolve(), abort: new AbortController(), rows: new Map() })
    this.#notify()
    return structuredClone(identity)
  }
  async challenge(context: TrustedTelemetryContext, signal: AbortSignal): Promise<CollectionChallenge | null> {
    const state = this.#device(context)
    await this.#active(state, signal)
    const mono = this.ports.clock.monotonicMs()
    for (const [id, item] of state.challenges) if (mono - item.monoMs >= TELEMETRY_LIMITS.freshMs) state.challenges.delete(id)
    if (mono - state.lastIssued < TELEMETRY_LIMITS.intervalMs || state.challenges.size >= TELEMETRY_LIMITS.outstanding) return null
    const wall = this.ports.clock.unixMs()
    const challenge: CollectionChallenge = { schemaVersion: 1, identity: structuredClone(state.identity), challengeId: randomUUID(),
      issuedAtUnixMs: wall, freshUntilUnixMs: wall + TELEMETRY_LIMITS.freshMs }
    state.challenges.set(challenge.challengeId, { monoMs: mono, challenge })
    state.lastIssued = mono
    return challenge
  }
  /** Raw uncompressed JSON is bounded before parsing. W07 supplies authenticated context separately. */
  async ingest(context: TrustedTelemetryContext, json: string, signal: AbortSignal): Promise<IngestReceipt> {
    if (Buffer.byteLength(json, 'utf8') > TELEMETRY_LIMITS.batchBytes) throw new TelemetryRejected('batch-limit')
    const state = this.#device(context)
    if (state.queued >= TELEMETRY_LIMITS.queuedFrames) throw new TelemetryRejected('backpressure')
    state.queued++
    const prior = state.tail
    let release!: () => void
    state.tail = new Promise<void>(resolve => { release = resolve })
    const pending = state.tail
    this.#pending.add(pending)
    signal = AbortSignal.any([signal, state.abort.signal])
    try { await prior; signal.throwIfAborted(); return await this.#accept(state, json, signal) }
    finally { state.queued--; release(); this.#pending.delete(pending) }
  }
  async #accept(state: DeviceState, json: string, signal: AbortSignal): Promise<IngestReceipt> {
    await this.#active(state, signal)
    let batch: TelemetryCollectedBatch
    try {
      const raw: unknown = JSON.parse(json)
      const bounded = (value: unknown, depth: number): void => {
        if (depth > 12) throw new TelemetryRejected('depth-limit')
        if (typeof value === 'string' && Buffer.byteLength(value) > 128) throw new TelemetryRejected('string-limit')
        if (value !== null && typeof value === 'object') for (const child of Object.values(value)) bounded(child, depth + 1)
      }
      bounded(raw, 0)
      batch = TelemetryCollectedBatchSchema.parse(raw)
    } catch { throw new TelemetryRejected('schema') }
    if (identityKey(batch.identity) !== identityKey(state.identity)) throw new TelemetryRejected('identity')
    const seq = BigInt(batch.sequence)
    const hash = digest(batch)
    if (state.sequence !== null && seq <= state.sequence) {
      if (seq === state.sequence && hash === state.digest && state.receipt) return { ...state.receipt, status: 'duplicate' }
      throw new TelemetryRejected(seq === state.sequence ? 'conflicting-duplicate' : 'out-of-order')
    }
    const challenge = state.challenges.get(batch.challengeId)
    const now = this.ports.clock.monotonicMs()
    if (!challenge || now - challenge.monoMs < 0 || now - challenge.monoMs >= TELEMETRY_LIMITS.freshMs) throw new TelemetryRejected('challenge')
    const rows = [...(batch.host ? [batch.host] : []), ...batch.owned]
    if (rows.length > TELEMETRY_LIMITS.rows || new Set(rows.map(row => telemetrySelectorKey(row.selector))).size !== rows.length) throw new TelemetryRejected('row-limit')
    const validated: { row: TelemetryCollectedRow; lifecycle: TelemetrySample['ownershipState']; sharedOwners: readonly TelemetryOwner[] | null }[] = []
    for (const row of rows) {
      if (row.selector.mainId !== state.identity.mainId || telemetryCanonical(row.selector.host) !== telemetryCanonical(state.identity.host)) throw new TelemetryRejected('observed-host')
      if (row.selector.scope === 'owned') {
        const owner = await this.ports.ownership.resolve(row.selector, signal)
        if (!this.#ownerMatches(row, owner)) throw new TelemetryRejected('owner-binding')
        if (owner.sharedOwners.length && !row.coverage.shared) throw new TelemetryRejected('shared-binding')
        validated.push({ row, lifecycle: owner.state, sharedOwners: null })
      } else validated.push({ row, lifecycle: 'active', sharedOwners: [] })
    }
    // Async authority reads may race revocation or deadline; revalidate before committing.
    await this.#active(state, signal)
    for (const entry of validated) if (entry.row.selector.scope === 'owned') {
      const row = entry.row as TelemetryCollectedRow & { selector: Extract<TelemetrySelector, { scope: 'owned' }> }
      const currentOwner = await this.ports.ownership.resolve(row.selector, signal)
      if (!this.#ownerMatches(row, currentOwner)) throw new TelemetryRejected('owner-binding')
      if (currentOwner.sharedOwners.length && !row.coverage.shared) throw new TelemetryRejected('shared-binding')
      entry.lifecycle = currentOwner.state
      // Capture membership by value; later ownership changes cannot authorize historical numbers.
      entry.sharedOwners = !row.coverage.shared ? [] : currentOwner.sharedOwners.length && currentOwner.sharedOwnersComplete !== false
        ? structuredClone(currentOwner.sharedOwners) : null
    }
    if (state.retired) throw new TelemetryRejected('authorization')
    const commitMono = this.ports.clock.monotonicMs()
    if (commitMono - challenge.monoMs >= TELEMETRY_LIMITS.freshMs || state.challenges.get(batch.challengeId) !== challenge) throw new TelemetryRejected('challenge')
    const sampleId = `resource-telemetry/v1:${digest(state.identity)}:${batch.sequence}`
    const receipt: IngestReceipt = { status: 'accepted', sampleId,
      gaps: state.sequence === null ? '0' : (seq - state.sequence - 1n).toString() }
    const wall = this.ports.clock.unixMs()
    const freshUntil = Math.floor(wall + TELEMETRY_LIMITS.freshMs - (commitMono - challenge.monoMs))
    const replacements = new Map<string, RetainedRow>()
    for (const { row, lifecycle, sharedOwners } of validated) {
      const key = telemetrySelectorKey(row.selector)
      const retained = state.rows.get(key)
      const previous = retained && !('reason' in retained) ? retained : undefined
      const base = { sampledAtUnixMs: batch.collectedAtUnixMs, freshUntilUnixMs: freshUntil }
      const cpu = this.#cpu(batch, row, previous)
      const sample: TelemetrySample = { schemaVersion: 1, selector: row.selector, selectorKey: key,
        identity: state.identity, sampleId, sequence: batch.sequence, collectedAtUnixMs: batch.collectedAtUnixMs,
        collectionDurationNs: (BigInt(batch.captureEndMonoNs) - BigInt(batch.captureStartMonoNs)).toString(),
        receivedAtUnixMs: wall, serverNowUnixMs: wall, ageUpperBoundMs: commitMono - challenge.monoMs, freshUntilUnixMs: freshUntil,
        presence: 'online', ownershipState: lifecycle,
        diagnostics: [...new Set([...batch.diagnostics, ...(Math.abs(wall - batch.collectedAtUnixMs) > 30_000 ? ['wall-clock-skew' as const] : [])])].slice(0, 16),
        coverage: batch.truncated ? { ...row.coverage, boundary: 'partial', reasons: [...new Set(['limit' as const, ...row.coverage.reasons])].slice(0, 16) } : row.coverage,
        cpu: cpu.kind === 'ok' ? { ...base, state: 'fresh', value: cpu.value, reason: null }
          : { ...base, state: cpu.state, value: null, reason: cpu.reason },
        memory: row.memory.state === 'ok' ? { ...base, state: 'fresh', value: row.memory.value, reason: null }
          : { ...base, state: row.memory.state, value: null, reason: row.memory.reason },
        ...(row.storage ? { storage: row.storage } : {}) }
      replacements.set(key, { latest: sample, lastKnown: sample.cpu.state === 'fresh' || sample.memory.state === 'fresh' ? structuredClone(sample) : previous?.lastKnown ?? null,
        sharedOwners, lastKnownSharedOwners: sample.cpu.state === 'fresh' || sample.memory.state === 'fresh' ? sharedOwners : previous?.lastKnownSharedOwners ?? null,
        issuedMonoMs: challenge.monoMs, storedMonoMs: commitMono,
        lastKnownMonoMs: sample.cpu.state === 'fresh' || sample.memory.state === 'fresh' ? commitMono : previous?.lastKnownMonoMs ?? commitMono,
        logicalCpuCount: batch.logicalCpuCount, contextKey: state.key, capture: row,
        captureStart: BigInt(batch.captureStartMonoNs), captureEnd: BigInt(batch.captureEndMonoNs) })
    }
    // Current accepted rows take capacity first; retained missing rows never remain fresh.
    for (const [key, cached] of state.rows) if (!replacements.has(key) && replacements.size < TELEMETRY_LIMITS.rows) {
      if ('reason' in cached) { replacements.set(key, cached); continue }
      replacements.set(key, { ...cached, latest: { ...cached.latest,
        coverage: { ...cached.latest.coverage, boundary: 'partial', reasons: ['source-failure'] },
        cpu: { state: 'unavailable', value: null, reason: 'source-failure', sampledAtUnixMs: null, freshUntilUnixMs: null },
        memory: { state: 'unavailable', value: null, reason: 'source-failure', sampledAtUnixMs: null, freshUntilUnixMs: null }, storage: null } })
    }
    state.rows = replacements
    state.sequence = seq; state.digest = hash; state.receipt = receipt
    state.challenges.delete(batch.challengeId)
    this.#trim()
    this.#notify()
    return receipt
  }
  #ownerMatches(row: TelemetryCollectedRow, owner: TelemetryOwnershipView | null): owner is TelemetryOwnershipView {
    if (!owner || telemetrySelectorKey(owner.selector) !== telemetrySelectorKey(row.selector)) return false
    if (owner.state === 'ended' || owner.state === 'closed') return row.cpu.state === 'unavailable' && row.cpu.reason === owner.state
      && row.memory.state === 'unavailable' && row.memory.reason === owner.state
    // Collector lifecycle claims cannot close an owner that the authority still considers live.
    return !(row.cpu.state !== 'ok' && (row.cpu.reason === 'ended' || row.cpu.reason === 'closed'))
      && !(row.memory.state !== 'ok' && (row.memory.reason === 'ended' || row.memory.reason === 'closed'))
  }
  #cpu(batch: TelemetryCollectedBatch, row: TelemetryCollectedRow, previous: CachedRow | undefined):
    | { kind: 'ok'; value: TelemetryCpu }
    | { kind: 'null'; state: 'warmup' | 'unavailable' | 'permission-denied'; reason: TelemetryReason } {
    const c = row.cpu
    if (batch.diagnostics.includes('clock-discontinuity')) return { kind: 'null', state: 'warmup', reason: 'clock-discontinuity' }
    if (c.state !== 'ok') return { kind: 'null', state: c.state, reason: c.reason }
    const invalid = { kind: 'null', state: 'unavailable', reason: 'counter-invalid' } as const
    const warmup = { kind: 'null', state: 'warmup', reason: 'warmup' } as const
    const start = BigInt(c.windowStartMonoNs), end = BigInt(c.windowEndMonoNs), elapsed = end - start
    if (elapsed > 6_000_000_000n) return warmup
    if (elapsed <= 0n || end < BigInt(batch.captureStartMonoNs) || end > BigInt(batch.captureEndMonoNs)) return invalid
    if (!previous || previous.logicalCpuCount !== batch.logicalCpuCount
      || previous.capture.cpu.state === 'unavailable' || previous.capture.cpu.state === 'permission-denied'
      || this.ports.clock.monotonicMs() - previous.issuedMonoMs >= TELEMETRY_LIMITS.freshMs
      || start < previous.captureStart || start > previous.captureEnd) return warmup
    if (previous.capture.cpu.state === 'ok' && (previous.capture.cpu.baselineRef !== c.baselineRef
      || previous.capture.cpu.basis !== c.basis)) return warmup
    if (previous.capture.cpu.state === 'ok' && c.basis !== 'process-utime-stime'
      && (previous.capture.cpu.currentCounter !== c.previousCounter || previous.capture.cpu.currentTotal !== c.previousTotal)) return invalid
    let hostCapacityPercent: number, oneCorePercent: number | null = null, cpuDeltaNs: string | null = null
    if (c.basis === 'host-active-ticks') {
      if (row.selector.scope !== 'computer' || c.previousTotal === null || c.currentTotal === null || c.intervalDeltaNs !== null) return invalid
      const active = BigInt(c.currentCounter) - BigInt(c.previousCounter), total = BigInt(c.currentTotal) - BigInt(c.previousTotal)
      if (active < 0n || total <= 0n || active > total) return invalid
      hostCapacityPercent = Number(active) / Number(total) * 100
    } else {
      if (row.selector.scope !== 'owned' || c.previousTotal !== null || c.currentTotal !== null) return invalid
      const delta = c.basis === 'process-utime-stime' ? c.intervalDeltaNs === null ? -1n : BigInt(c.intervalDeltaNs)
        : (BigInt(c.currentCounter) - BigInt(c.previousCounter)) * 1000n
      if (delta < 0n || delta > elapsed * BigInt(batch.logicalCpuCount)) return invalid
      oneCorePercent = Number(delta) / Number(elapsed) * 100
      hostCapacityPercent = oneCorePercent / batch.logicalCpuCount
      cpuDeltaNs = delta.toString()
    }
    return { kind: 'ok', value: { basis: c.basis, normalization: 'whole-host-capacity', logicalCpuCount: batch.logicalCpuCount,
      hostCapacityPercent, oneCorePercent, elapsedNs: elapsed.toString(), cpuDeltaNs } }
  }
  #retainedBytes(key: string, row: RetainedRow): number {
    // Conservative UTF-16/object/map overhead allowance; no process tables are retained.
    return 1024 + 2 * Buffer.byteLength(JSON.stringify('reason' in row ? { key, ...row } : { key, latest: row.latest, lastKnown: row.lastKnown,
      sharedOwners: row.sharedOwners, lastKnownSharedOwners: row.lastKnownSharedOwners, capture: row.capture }))
  }
  #trim(): void {
    const now = this.ports.clock.monotonicMs()
    let bytes = 0
    const rows: { state: DeviceState; key: string; row: RetainedRow }[] = []
    for (const state of this.#devices.values()) for (const [key, row] of state.rows) {
      const retained: RetainedRow = !('reason' in row) && now - row.lastKnownMonoMs >= TELEMETRY_LIMITS.lastKnownMs
        ? { reason: row.latest.ownershipState === 'ended' || row.latest.ownershipState === 'closed' ? row.latest.ownershipState
          : row.latest.cpu.reason !== null && row.latest.cpu.reason === row.latest.memory.reason ? row.latest.cpu.reason : 'stale', storedMonoMs: row.storedMonoMs }
        : row
      state.rows.set(key, retained)
      bytes += this.#retainedBytes(key, retained)
      rows.push({ state, key, row: retained })
    }
    rows.sort((a, b) => a.row.storedMonoMs - b.row.storedMonoMs)
    for (const item of rows) {
      if (bytes <= TELEMETRY_LIMITS.cacheBytes) break
      bytes -= this.#retainedBytes(item.key, item.row)
      if ('reason' in item.row) item.state.rows.delete(item.key)
      else {
        const tombstone: RowTombstone = { reason: item.row.latest.ownershipState === 'ended' || item.row.latest.ownershipState === 'closed'
          ? item.row.latest.ownershipState : 'evicted', storedMonoMs: item.row.storedMonoMs }
        item.state.rows.set(item.key, tombstone); item.row = tombstone
        bytes += this.#retainedBytes(item.key, tombstone)
      }
    }
    // Tombstones share the existing row/device/byte bounds; under further pressure oldest reasons may also be dropped.
    for (const item of rows) {
      if (bytes <= TELEMETRY_LIMITS.cacheBytes) break
      if ('reason' in item.row && item.state.rows.has(item.key)) { bytes -= this.#retainedBytes(item.key, item.row); item.state.rows.delete(item.key) }
    }
  }
  revoke(context: TrustedTelemetryContext): void {
    const state = this.#devices.get(contextKey(context))
    if (!state) return
    state.retired = true; state.abort.abort(new TelemetryRejected('authorization')); state.challenges.clear(); state.rows.clear(); this.#devices.delete(state.key)
    this.#notify()
  }
  #principalActive(principal: ManagementPrincipal): boolean {
    const parsed = ManagementPrincipalSchema.safeParse(principal)
    return parsed.success && parsed.data.audience === 'operator' && parsed.data.revokedAt === null
      && Date.parse(parsed.data.expiresAt) > this.ports.clock.unixMs()
  }
  async #sharedAllowed(principal: ManagementPrincipal, owners: readonly TelemetryOwner[] | null, signal: AbortSignal): Promise<boolean> {
    if (owners === null) return false
    for (const owner of owners) if (!await this.ports.reads.allowSharedOwner(principal, owner, signal)) return false
    return true
  }
  /** Resolve public references only from current authenticated identities and existing scoped ownership. */
  async resolveSelector(principal: ManagementPrincipal, rawTarget: TelemetrySelectorTarget, signal: AbortSignal,
    authority: TelemetryTargetAuthority): Promise<TelemetrySelectorResult> {
    const target = TelemetrySelectorTargetSchema.parse(rawTarget)
    signal.throwIfAborted()
    const denied = { kind: 'denied' } as const, unavailable = { kind: 'unavailable' } as const
    if (!this.#principalActive(principal) || !await authority.allowTarget(principal, target, signal)) return denied
    let facts: TelemetryOwnedTargetFacts | undefined
    if (target.scope === 'owned') {
      const resolved = await authority.resolveOwned(principal, target, signal)
      if (resolved.kind !== 'owned') return resolved
      facts = resolved.facts
      const owner = facts.owner, reference = target.target
      const matches = owner.kind === 'workflow-execution' && reference.kind === owner.kind
        ? owner.workspaceId === reference.workspaceId && owner.workflowId === reference.workflowId
          && owner.runId === reference.runId && owner.nodeId === reference.nodeId && owner.executionId === reference.executionId
        : owner.kind === 'ci-job' && reference.kind === owner.kind
          ? owner.subject.workspaceId === reference.workspaceId && owner.executionId === reference.jobExecutionId && owner.attemptId === reference.attemptId
          : owner.kind === 'agent-conversation' && reference.kind === owner.kind
            ? owner.workspaceId === reference.workspaceId && owner.workflowId === reference.workflowId
              && owner.nodeId === reference.nodeId && owner.agentId === reference.agentId && owner.conversationId === reference.conversationId
            : owner.kind === 'operator-conversation' && reference.kind === owner.kind && owner.conversationId === reference.conversationId
      if (!matches) return unavailable
    }
    signal.throwIfAborted()
    if (!this.#principalActive(principal)) return denied
    const state = [...this.#devices.values()].find(item => item.identity.mainId === target.mainId
      && (target.scope === 'computer' ? telemetryCanonical(item.identity.host.hostRef) === telemetryCanonical(target.hostRef)
        : facts && telemetryCanonical({ ...item.identity.host, collectorGeneration: null }) === telemetryCanonical({ ...facts.host, collectorGeneration: null })))
    if (!state || state.retired || this.#closed) return unavailable
    const parsed = TelemetrySelectorSchema.safeParse(target.scope === 'computer'
      ? { schemaVersion: 1, scope: 'computer', mainId: target.mainId, host: state.identity.host }
      : { schemaVersion: 1, scope: 'owned', mainId: target.mainId, host: state.identity.host,
        owner: facts!.owner, attributionRef: facts!.attributionRef, attributionRevision: facts!.attributionRevision })
    if (!parsed.success) return unavailable
    const result = await this.read(principal, parsed.data, signal)
    if (result.kind === 'denied') return denied
    if (result.kind === 'no-sample' && (result.reason === 'ownership-unavailable' || result.reason === 'shared-restricted')) return unavailable
    signal.throwIfAborted()
    if (!this.#principalActive(principal) || !await authority.allowTarget(principal, target, signal)) return denied
    if (state.retired || this.#closed || this.#devices.get(state.key) !== state) return unavailable
    return { kind: 'selector', selector: structuredClone(parsed.data) }
  }
  async read(principal: ManagementPrincipal, rawSelector: TelemetrySelector, signal: AbortSignal): Promise<TelemetryReadResult> {
    const selector = TelemetrySelectorSchema.parse(rawSelector), key = telemetrySelectorKey(selector)
    signal.throwIfAborted()
    const denied = { kind: 'denied', selectorKey: key } as const
    if (!this.#principalActive(principal) || !await this.ports.reads.allow(principal, selector, signal)) return denied
    this.#trim()
    const state = [...this.#devices.values()].find(item => item.identity.mainId === selector.mainId
      && telemetryCanonical(item.identity.host) === telemetryCanonical(selector.host))
    const noSample = (reason: TelemetryReason): TelemetryReadResult =>
      ({ kind: 'no-sample', selector, selectorKey: key, reason, identity: null })
    let lifecycle: TelemetrySample['ownershipState'] = 'active', shared = false, sharedOwnersComplete = true
    if (selector.scope === 'owned') {
      const owner = await this.ports.ownership.resolve(selector, signal)
      if (!owner || telemetrySelectorKey(owner.selector) !== key) return noSample('ownership-unavailable')
      lifecycle = owner.state; shared = owner.sharedOwners.length > 0; sharedOwnersComplete = owner.sharedOwnersComplete !== false
      for (const sharedOwner of owner.sharedOwners) if (!await this.ports.reads.allowSharedOwner(principal, sharedOwner, signal)) return noSample('shared-restricted')
    }
    if (!state) return noSample('not-yet-sampled')
    if (!await this.ports.sessions.active(state.context, signal)) { this.revoke(state.context); return denied }
    const presence = await this.ports.sessions.presence(state.context, signal)
    // Denial/revocation occurring during any asynchronous read wins over cached metrics.
    if (!this.#principalActive(principal) || !await this.ports.reads.allow(principal, selector, signal)) return denied
    signal.throwIfAborted()
    if (state.retired || !await this.ports.sessions.active(state.context, signal)) { this.revoke(state.context); return denied }
    if (selector.scope === 'owned') {
      const currentOwner = await this.ports.ownership.resolve(selector, signal)
      if (!currentOwner || telemetrySelectorKey(currentOwner.selector) !== key) return noSample('ownership-unavailable')
      lifecycle = currentOwner.state; shared = currentOwner.sharedOwners.length > 0; sharedOwnersComplete = currentOwner.sharedOwnersComplete !== false
      for (const owner of currentOwner.sharedOwners) if (!await this.ports.reads.allowSharedOwner(principal, owner, signal)) return noSample('shared-restricted')
      if (!this.#principalActive(principal) || state.retired || !await this.ports.reads.allow(principal, selector, signal)) return denied
    }
    const cached = state.rows.get(key)
    if (!cached || 'reason' in cached) return noSample(lifecycle === 'ended' || lifecycle === 'closed' ? lifecycle : cached?.reason ?? 'not-yet-sampled')
    if (shared !== cached.latest.coverage.shared || cached.latest.coverage.shared && !sharedOwnersComplete) return noSample('shared-restricted')
    if (!await this.#sharedAllowed(principal, cached.sharedOwners, signal)) return noSample('shared-restricted')
    const lastKnownAllowed = cached.lastKnown !== null && this.ports.clock.monotonicMs() - cached.lastKnownMonoMs < TELEMETRY_LIMITS.lastKnownMs
      && await this.#sharedAllowed(principal, cached.lastKnownSharedOwners, signal)
    if (!this.#principalActive(principal) || state.retired || !await this.ports.reads.allow(principal, selector, signal)) return denied
    signal.throwIfAborted()
    if (state.retired || !await this.ports.sessions.active(state.context, signal)) { this.revoke(state.context); return denied }
    const age = this.ports.clock.monotonicMs() - cached.issuedMonoMs
    const current = structuredClone(cached.latest)
    current.serverNowUnixMs = this.ports.clock.unixMs(); current.ageUpperBoundMs = age
    current.freshUntilUnixMs = Math.floor(current.serverNowUnixMs + Math.max(0, TELEMETRY_LIMITS.freshMs - age))
    current.presence = presence; current.ownershipState = lifecycle
    if (current.cpu.freshUntilUnixMs !== null) current.cpu.freshUntilUnixMs = current.freshUntilUnixMs
    if (current.memory.freshUntilUnixMs !== null) current.memory.freshUntilUnixMs = current.freshUntilUnixMs
    if (presence === 'offline' || age >= TELEMETRY_LIMITS.freshMs || age < 0 || lifecycle === 'ended' || lifecycle === 'closed') {
      const reason = presence === 'offline' ? 'offline' : lifecycle === 'ended' || lifecycle === 'closed' ? lifecycle : 'stale'
      current.cpu = { ...current.cpu, state: 'stale', value: null, reason }
      current.memory = { ...current.memory, state: 'stale', value: null, reason }
      if (current.storage) current.storage = null
    }
    return { kind: 'sample', sample: current, lastKnown: lastKnownAllowed
      && this.ports.clock.monotonicMs() - cached.lastKnownMonoMs < TELEMETRY_LIMITS.lastKnownMs ? structuredClone(cached.lastKnown) : null }
  }
  /** Internal Job admission consumes only fresh computer data on its authorized host and installation. */
  async availableComputerMemory(expected: Pick<TelemetryHost,
    'hostRef' | 'applicationInstallationId' | 'bootId' | 'keyRevision' | 'authorizationRevision'>,
  signal: AbortSignal): Promise<number | null> {
    signal.throwIfAborted()
    this.#trim()
    const states = [...this.#devices.values()].filter(state => !state.retired
      && Object.entries(expected).every(([key, value]) =>
        telemetryCanonical(Reflect.get(state.identity.host, key)) === telemetryCanonical(value)))
    if (this.#closed || states.length !== 1) return null
    const state = states[0]!
    if (!await this.ports.sessions.active(state.context, signal)) { this.revoke(state.context); return null }
    const presence = await this.ports.sessions.presence(state.context, signal)
    signal.throwIfAborted()
    if (presence !== 'online' || state.retired || this.#closed
      || !await this.ports.sessions.active(state.context, signal)) return null
    signal.throwIfAborted()
    if (state.retired || this.#closed || this.#devices.get(state.key) !== state) return null
    const selector: TelemetrySelector = { schemaVersion: 1, scope: 'computer',
      mainId: state.identity.mainId, host: state.identity.host }
    const cached = state.rows.get(telemetrySelectorKey(selector))
    if (!cached || !('latest' in cached)) return null
    const age = this.ports.clock.monotonicMs() - cached.issuedMonoMs
    const metric = cached.latest.memory
    if (age < 0 || age >= TELEMETRY_LIMITS.freshMs || metric.state !== 'fresh'
      || metric.value?.kind !== 'host-used-estimate') return null
    return metric.value.availableBytes
  }
  async *changes(principal: ManagementPrincipal, selector: TelemetrySelector, signal: AbortSignal): AsyncIterable<TelemetryReadResult> {
    if (this.#listeners.size >= 256) throw new TelemetryRejected('reader-limit')
    let wake: (() => void) | null = null, dirty = true, previous = ''
    const notify = () => { dirty = true; wake?.(); if (this.#closed) { this.#listeners.delete(notify); signal.removeEventListener('abort', cleanup) } }
    this.#listeners.add(notify)
    const cleanup = () => { this.#listeners.delete(notify); wake?.() }
    signal.addEventListener('abort', cleanup, { once: true })
    try {
      while (!signal.aborted && !this.#closed) {
        if (!dirty) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); wake = null; resolve() }
          const timer = setTimeout(done, 1000)
          wake = done; signal.addEventListener('abort', done, { once: true })
          if (dirty || signal.aborted || this.#closed) done()
        })
        if (signal.aborted || this.#closed) return
        dirty = false
        const result = await this.read(principal, selector, signal)
        // Age is intentionally refreshed; only one result is retained under slow consumption.
        const next = telemetryCanonical(result)
        if (next !== previous) { previous = next; yield result }
      }
    } finally { signal.removeEventListener('abort', cleanup); cleanup() }
  }
  async close(): Promise<void> {
    this.#closed = true
    const tails = [...this.#pending]
    for (const state of this.#devices.values()) this.revoke(state.context)
    this.#notify()
    this.#listeners.clear()
    await Promise.all(tails)
  }
}
