import {
  TELEMETRY_LIMITS, type ResourceCollector, type TelemetryIdentity, type TrustedTelemetryContext,
} from '@foreman-code/contracts/resource-telemetry'
import { newCollectorGeneration } from './collector/lifecycle.js'
import { createLinuxResourceCollector } from './collector/ports.js'
import { trackService } from '../diagnostics/serviceHealth.js'
import { passiveRegistryOwnershipReader, type PassiveNativeRegistry, type TrustedNativeScopes } from './collector/registryAdapter.js'
import { ResourceTelemetryService, TelemetryRejected } from './ingestion/service.js'
import type { TelemetryClock, TelemetryOwnershipReader, TelemetryReadAuthority, TelemetrySessionReader } from './ingestion/ports.js'
import { ResourceTelemetrySelectors, type TelemetryTargetAuthority } from './readback/selector.js'

export interface ResourceTelemetryRuntimeInput {
  localContext: Extract<TrustedTelemetryContext, { kind: 'main-local' }>
  sessions: TelemetrySessionReader
  ownership: TelemetryOwnershipReader
  reads: TelemetryReadAuthority
  targets: TelemetryTargetAuthority
  registry: PassiveNativeRegistry
  /** Exact HRT/W08/CI/conversation projections, bound to this authenticated collector identity. */
  nativeScopes(identity: TelemetryIdentity): TrustedNativeScopes
  wholeHostVisible: boolean
  signal: AbortSignal
  clock?: TelemetryClock
  createCollector?: (input: Parameters<typeof createLinuxResourceCollector>[0]) => Promise<ResourceCollector>
}
export type TelemetryRuntimeCompletion = { kind: 'closed' } | { kind: 'failed'; error: unknown }
export interface ResourceTelemetryRuntime {
  readonly service: ResourceTelemetryService
  readonly selectors: ResourceTelemetrySelectors
  readonly identity: TelemetryIdentity
  readonly completion: Promise<TelemetryRuntimeCompletion>
  close(): Promise<void>
}
/** Called by the existing runtime owner after acquisition. No owner/provider/transport is acquired here. */
export async function createResourceTelemetryRuntime(input: ResourceTelemetryRuntimeInput): Promise<ResourceTelemetryRuntime> {
  input.signal.throwIfAborted()
  if (input.localContext.deviceId !== input.localContext.mainId) throw new Error('Main telemetry device must use its canonical main identity.')
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal.reason)
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  const clock = input.clock ?? { monotonicMs: () => Number(process.hrtime.bigint()) / 1_000_000, unixMs: Date.now }
  const service = new ResourceTelemetryService({ clock, sessions: input.sessions, ownership: input.ownership, reads: input.reads })
  let collector: ResourceCollector | undefined
  let identity: TelemetryIdentity
  try {
    identity = await service.handshake(input.localContext, newCollectorGeneration(), controller.signal)
    const ownership = passiveRegistryOwnershipReader(input.registry, input.nativeScopes(structuredClone(identity)))
    collector = await (input.createCollector ?? createLinuxResourceCollector)({ identity, ownership,
      wholeHostVisible: input.wholeHostVisible, signal: controller.signal })
    controller.signal.throwIfAborted()
  } catch (error) {
    controller.abort(error); input.signal.removeEventListener('abort', abort)
    await collector?.close()
    await service.close()
    throw error
  }
  const activeCollector = collector
  let failure: unknown
  const wait = () => new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve() }
    const timer = setTimeout(finish, TELEMETRY_LIMITS.intervalMs)
    controller.signal.addEventListener('abort', finish, { once: true })
    if (controller.signal.aborted) finish()
  })
  const run = async (work: () => Promise<void>) => {
    try { await work() }
    catch (error) { if (!controller.signal.aborted) { failure = error; controller.abort(error) } }
  }
  const pump = run(async () => {
    for await (const batch of activeCollector.samples(controller.signal)) {
      controller.signal.throwIfAborted()
      try { await service.ingest(input.localContext, JSON.stringify(batch), controller.signal) }
      catch (error) {
        // Ownership may change after capture, or a delayed capture may outlive its challenge. Neither frame becomes fresh.
        if (!(error instanceof TelemetryRejected) || error.reason !== 'owner-binding' && error.reason !== 'challenge') throw error
      }
    }
    if (!controller.signal.aborted) throw new Error('Telemetry collector ended before runtime shutdown.')
  })
  const cadence = run(async () => {
    while (!controller.signal.aborted) {
      await trackService('telemetry-collector', { cadenceMs: TELEMETRY_LIMITS.intervalMs, deadlineMs: 60_000 }, async () => {
        const challenge = await service.challenge(input.localContext, controller.signal)
        // A full bounded collector queue leaves this challenge unsampled; a later cadence retries.
        if (challenge) activeCollector.offer(challenge)
      })
      await wait()
    }
  })
  const completion: Promise<TelemetryRuntimeCompletion> = Promise.all([pump, cadence]).then(async () => {
    try { await activeCollector.close() } catch (error) { failure ??= error }
    try { await service.close() } catch (error) { failure ??= error }
    input.signal.removeEventListener('abort', abort)
    return failure === undefined ? { kind: 'closed' } : { kind: 'failed', error: failure }
  })
  return { service, selectors: new ResourceTelemetrySelectors(service, input.targets),
    get identity() { return structuredClone(identity) }, completion,
    async close() {
      controller.abort()
      const result = await completion
      if (result.kind === 'failed') throw result.error
    },
  }
}
