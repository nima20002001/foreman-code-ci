import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import type { LogComponent } from './logComponent.js'

export interface RuntimeTimingFields {
  runId?: string
  executionId?: string
  nativeTurnId?: string
  nativeSessionId?: string
  laneId?: string
  correlationId?: string
  ownerId?: string
  operation?: string
  statementId?: string
  eventType?: string
  nativeMethod?: string
  itemType?: string
  sequence?: number
  count?: number
  intervalMs?: number
  reused?: boolean
  statusCode?: number
  attempt?: number
  success?: boolean
}
export interface RuntimeTimingRecord extends RuntimeTimingFields {
  component: LogComponent
  phase: string
  startedAt: string
  finishedAt: string
  durationMs: number
}

export const runtimeTimingChannel = channel('foreman-code.runtime-timing')
const scope = new AsyncLocalStorage<RuntimeTimingFields>()
const noop = () => undefined

/** Passive diagnostics carry identifiers and durations, never model content or SQL. */
export function beginRuntimeTiming(component: LogComponent, phase: string, fields: RuntimeTimingFields = {}) {
  if (!runtimeTimingChannel.hasSubscribers) return noop
  const identity = { ...scope.getStore(), ...fields }
  const started = performance.now()
  const startedAt = new Date().toISOString()
  let finished = false
  return () => {
    if (finished) return
    finished = true
    const record: RuntimeTimingRecord = { ...identity, component, phase, startedAt,
      finishedAt: new Date().toISOString(), durationMs: performance.now() - started }
    if (runtimeTimingChannel.hasSubscribers) runtimeTimingChannel.publish(record)
  }
}

export function runtimeTimingPoint(component: LogComponent, phase: string, fields: RuntimeTimingFields = {}) {
  beginRuntimeTiming(component, phase, fields)()
}

/** Exported native events arrive later; keep the admission's identity and the native clock. */
export function runtimeTimingPublisher() {
  const identity = { ...scope.getStore() }
  return (record: RuntimeTimingRecord) => {
    if (runtimeTimingChannel.hasSubscribers) runtimeTimingChannel.publish({ ...identity, ...record })
  }
}

export function withRuntimeTimingContext<T>(fields: RuntimeTimingFields, work: () => T): T {
  return scope.run({ ...scope.getStore(), ...fields }, work)
}

export function timeRuntimeOperation<T>(component: LogComponent, phase: string,
  work: () => Promise<T>, fields: RuntimeTimingFields = {}): Promise<T> {
  const finished = beginRuntimeTiming(component, phase, fields)
  if (finished === noop) return work()
  try { return work().finally(finished) }
  catch (error) { finished(); throw error }
}
