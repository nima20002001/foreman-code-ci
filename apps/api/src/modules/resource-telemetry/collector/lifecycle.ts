import { randomUUID } from 'node:crypto'
import { CollectionChallengeSchema, TelemetryIdentitySchema, TelemetryCollectedBatchSchema, telemetryCanonical, type CollectionChallenge, type ResourceCollector, type TelemetryCollectedBatch, type TelemetryIdentity } from '@foreman-code/contracts/resource-telemetry'
import { LinuxSampler, type SamplerPorts } from './sampler.js'
import { logIgnoredError } from '../../diagnostics/ignoredError.js'

export interface CollectorClock { now(): bigint; wall(): number; setTimer(work: () => void, ms: number): ReturnType<typeof setTimeout>; clearTimer(timer: ReturnType<typeof setTimeout>): void }
const defaultClock: CollectorClock = { now: () => process.hrtime.bigint(), wall: Date.now, setTimer: setTimeout, clearTimer: clearTimeout }
/** Passive one-host sampler. Only offered authenticated challenges drive captures. */
export function createResourceCollector(input: { identity: TelemetryIdentity; ports: SamplerPorts; clock?: CollectorClock }): ResourceCollector {
  const identity = TelemetryIdentitySchema.parse(input.identity)
  const clock = input.clock ?? defaultClock
  const sampler = new LinuxSampler(input.ports)
  const controller = new AbortController()
  let closed = false; let join: Promise<void> | undefined; let timer: ReturnType<typeof setTimeout> | undefined
  let running: Promise<void> | undefined; let sequence = 0n; let nextAt = 0n
  const challenges: Array<{ challenge: CollectionChallenge; received: bigint }> = []
  const frames: TelemetryCollectedBatch[] = []
  const seen = new Set<string>()
  let notify: (() => void) | undefined
  let reading = false
  let listenerCleanup: (() => void) | undefined
  const schedule = () => {
    if (closed || running || timer || !challenges.length) return
    const delay = nextAt > clock.now() ? Number((nextAt - clock.now() + 999_999n) / 1_000_000n) : 0
    timer = clock.setTimer(() => {
      timer = undefined
      if (closed || !challenges.length) return
      const request = challenges.shift()!
      const start = clock.now()
      nextAt = start + 2_000_000_000n
      running = (async () => {
        try {
          const capture = await sampler.capture(identity, controller.signal)
          if (closed) return
          const batch: TelemetryCollectedBatch = { schemaVersion: 1, identity, challengeId: request.challenge.challengeId,
            sequence: (++sequence).toString(), collectedAtUnixMs: clock.wall(), challengeReceivedMonoNs: request.received.toString(),
            captureStartMonoNs: start.toString(), captureEndMonoNs: clock.now().toString(), ...capture }
          // Drop oldest scope rows only with explicit truncation. Never retain an overflow queue.
          while (Buffer.byteLength(JSON.stringify(batch)) > 65536 && batch.owned.length) { batch.owned.pop(); batch.truncated = true }
          if (Buffer.byteLength(JSON.stringify(batch)) > 65536) {
            throw Object.assign(new Error('Telemetry sample exceeds the frame limit.'), { code: 'TELEMETRY_FRAME_TOO_LARGE' })
          }
          TelemetryCollectedBatchSchema.parse(batch)
          if (frames.length === 2) frames.shift()
          frames.push(batch); notify?.(); notify = undefined
        } catch (error) {
          if (!controller.signal.aborted) logIgnoredError('lifecycle', 'capture resource telemetry sample', error)
          // Metrics degrade only. No provider/ownership mutation or cleanup is called here.
          sampler.reset()
        }
      })().finally(() => { running = undefined; const now = clock.now(); if (nextAt < now) nextAt += ((now - nextAt) / 2_000_000_000n + 1n) * 2_000_000_000n; schedule() })
    }, delay)
  }
  return {
    offer(value) {
      if (closed) return 'rejected'
      const parsed = CollectionChallengeSchema.safeParse(value)
      if (!parsed.success || telemetryCanonical(parsed.data.identity) !== telemetryCanonical(identity)) return 'rejected'
      if (seen.has(value.challengeId)) return 'coalesced'
      if (challenges.length + (running ? 1 : 0) >= 2) return 'rejected'
      // B fences replay across challenge lifetime; this bounded local set prevents repeated recent capture.
      seen.add(value.challengeId)
      if (seen.size > 128) seen.delete(seen.values().next().value!)
      challenges.push({ challenge: parsed.data, received: clock.now() }); schedule(); return 'accepted'
    },
    async *samples(signal) {
      if (reading) throw new Error('Only one collector frame consumer is supported.')
      reading = true
      const abort = () => { notify?.(); notify = undefined }
      signal.addEventListener('abort', abort)
      listenerCleanup = () => signal.removeEventListener('abort', abort)
      try {
        while (!closed && !signal.aborted) {
          if (frames.length) { yield frames.shift()!; continue }
          await new Promise<void>(resolve => { notify = resolve; if (closed || signal.aborted) abort() })
        }
      } finally { listenerCleanup?.(); listenerCleanup = undefined; notify = undefined; reading = false }
    },
    close() {
      if (join) return join
      closed = true; controller.abort(); challenges.length = 0; frames.length = 0; seen.clear()
      if (timer) { clock.clearTimer(timer); timer = undefined }
      listenerCleanup?.(); listenerCleanup = undefined; notify?.(); notify = undefined
      join = (async () => { await running; sampler.reset() })()
      return join
    },
  }
}
/** Collector generation is established by the trusted runtime/connection owner. */
export const newCollectorGeneration = (): string => randomUUID()
