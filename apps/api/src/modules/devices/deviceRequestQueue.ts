import { AsyncLocalStorage } from 'node:async_hooks'
import {
  DEVICE_APPLICATION_IN_FLIGHT, DEVICE_APPLICATION_OBSERVATION_IN_FLIGHT, DEVICE_APPLICATION_STOP_IN_FLIGHT,
  DEVICE_APPLICATION_CALLBACK_IN_FLIGHT,
  type DeviceRequestPriority,
} from '@foreman-code/contracts/device-application'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from './deviceApplicationError.js'
import { WorkerConversationCallbackSchema } from '@foreman-code/contracts/remote-execution-rpc'

export const deviceForegroundWaitMs = 45_000
/** Slots that bulk transfers never take, so short calls (relay, status, control) are admitted while pages and logs stream. */
const interactiveSlotReserve = 4

interface RequestSlot {
  priority: DeviceRequestPriority
  stop: boolean
  bulk?: boolean
  observation?: boolean
  callback?: boolean
  namespace?: string
}
interface WaitingRequest {
  bulk: boolean
  observation: boolean
  callback: boolean
  admit(): void
  reject(error: Error): void
}
export interface DeviceRequestSlotSnapshot {
  active: number
  bulk: number
  observation: number
  waiting: number
  byNamespace: Record<string, number>
}

/** Background work leaves one slot available; observations use a separate bounded pool. */
export class DeviceRequestQueue {
  private active = 0
  private bulkActive = 0
  private observationActive = 0
  private callbackActive = 0
  private foreground = 0
  private stops = 0
  private readonly waiting: WaitingRequest[] = []
  private readonly namespaces = new Map<string, number>()
  private failure: Error | undefined

  get busy(): boolean {
    return this.waiting.some(waiter => !waiter.observation) || this.active >= DEVICE_APPLICATION_IN_FLIGHT - 1
  }

  snapshot(): DeviceRequestSlotSnapshot {
    return { active: this.active, bulk: this.bulkActive, observation: this.observationActive,
      waiting: this.waiting.length, byNamespace: Object.fromEntries(this.namespaces) }
  }

  async acquire({ priority, stop, bulk = false, observation = false, callback = false, namespace = 'unlabeled', signal,
    timeoutMs = deviceForegroundWaitMs }:
    RequestSlot & { signal?: AbortSignal | undefined; timeoutMs?: number }): Promise<() => void> {
    if (this.failure) throw this.failure
    if (signal?.aborted) throw new DeviceApplicationError('cancelled')
    const slot = { priority, stop, bulk, observation, callback, namespace }
    if (stop) {
      if (this.stops >= DEVICE_APPLICATION_STOP_IN_FLIGHT) throw new DeviceApplicationAdmissionError()
      return this.reserve(slot)
    }
    if (priority === 'background') {
      const busy = observation
        ? this.observationActive >= DEVICE_APPLICATION_OBSERVATION_IN_FLIGHT - 1
          || this.waiting.some(waiter => waiter.observation)
        : this.busy
      if (busy || !this.canAdmit(slot)) throw new DeviceApplicationAdmissionError('background_yield')
      return this.reserve(slot)
    }
    if (this.canAdmit(slot) && !this.waiting.some(waiter =>
      waiter.callback === callback && waiter.observation === observation && (observation || waiter.bulk === bulk))) {
      return this.reserve(slot)
    }
    if (this.waiting.filter(waiter => waiter.callback === callback && waiter.observation === observation).length >= 64)
      throw new DeviceApplicationAdmissionError('admission_queue_full')
    return new Promise<() => void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', cancel)
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
      }
      const waiter: WaitingRequest = {
        bulk, observation, callback,
        admit: () => { cleanup(); resolve(this.reserve(slot)) },
        reject: error => { cleanup(); reject(error); this.drain() },
      }
      const cancel = () => waiter.reject(new DeviceApplicationError('cancelled'))
      const timer = setTimeout(() => waiter.reject(new DeviceApplicationAdmissionError('admission_queue_timeout')),
        timeoutMs)
      this.waiting.push(waiter)
      signal?.addEventListener('abort', cancel, { once: true })
    })
  }

  private canAdmit({ bulk, observation, callback }: { bulk: boolean; observation: boolean; callback: boolean }): boolean {
    if (callback) return this.callbackActive < DEVICE_APPLICATION_CALLBACK_IN_FLIGHT
    if (observation) return this.observationActive < DEVICE_APPLICATION_OBSERVATION_IN_FLIGHT
    return this.active < DEVICE_APPLICATION_IN_FLIGHT
      && (!bulk || this.bulkActive < DEVICE_APPLICATION_IN_FLIGHT - interactiveSlotReserve)
  }

  private reserve({ priority, stop, bulk, observation, callback, namespace }: Required<RequestSlot>): () => void {
    const ordinary = !stop && !observation && !callback
    if (stop) this.stops++
    else if (observation) this.observationActive++
    else if (callback) this.callbackActive++
    else this.active++
    if (ordinary && bulk) this.bulkActive++
    if (!stop && priority === 'foreground') this.foreground++
    this.namespaces.set(namespace, (this.namespaces.get(namespace) ?? 0) + 1)
    return () => {
      if (stop) this.stops--
      else if (observation) this.observationActive--
      else if (callback) this.callbackActive--
      else this.active--
      if (ordinary && bulk) this.bulkActive--
      if (!stop && priority === 'foreground') this.foreground--
      const remaining = (this.namespaces.get(namespace) ?? 1) - 1
      if (remaining) this.namespaces.set(namespace, remaining)
      else this.namespaces.delete(namespace)
      this.drain()
    }
  }

  private drain(): void {
    if (this.failure) return
    for (const waiter of [...this.waiting]) if (this.canAdmit(waiter)) waiter.admit()
  }

  close(error: Error): void {
    this.failure = error
    for (const request of [...this.waiting]) request.reject(error)
  }
}

/** Transport capacity only; Main still checks the live admission and pending copy identity. */
export function deviceRequestIsCopyAuthorization(namespace: string, payload: unknown): boolean {
  if (namespace !== 'execution-v1') return false
  const parsed = WorkerConversationCallbackSchema.safeParse(payload)
  return parsed.success && parsed.data.method === 'conversation.file-copy-authorize'
}

const foregroundWork = new AsyncLocalStorage<true>()

/** Device requests made while serving an Operator or Agent tool call are foreground, whatever their namespace. */
export function asForegroundWork<T>(work: () => Promise<T>): Promise<T> {
  return foregroundWork.run(true, work)
}

export function effectiveDeviceRequestPriority(namespace: string, payload: unknown,
  explicit?: DeviceRequestPriority): DeviceRequestPriority {
  return explicit ?? (foregroundWork.getStore() ? 'foreground' : deviceRequestPriority(namespace, payload))
}

export function deviceRequestPriority(namespace: string, payload: unknown): DeviceRequestPriority {
  const operation = payload && typeof payload === 'object' && 'operation' in payload ? payload.operation : undefined
  if (namespace === 'host-harness-check-v1' && operation === 'operator-configuration-inspect') return 'foreground'
  if (['harness-discovery-v1', 'host-harness-check-v1', 'resource-telemetry'].includes(namespace)) return 'background'
  if (operation === 'status' && ['ci-host-v1', 'computer-maintenance-v2'].includes(namespace)) return 'background'
  return 'foreground'
}

/** Binary transfers, native history pages and CI log reads hold a slot for many round trips. */
export function deviceRequestIsBulk(namespace: string, payload: unknown, hasBytes: boolean): boolean {
  if (hasBytes) return true
  const fields = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  return namespace === 'execution-v1' && fields.method === 'history' || namespace === 'ci-host-v1' && fields.operation === 'read'
}

/** Provider history and physical settlement can outlast short device calls. */
export function deviceRequestIsObservation(namespace: string, payload: unknown): boolean {
  if (namespace === 'computer-maintenance-v2' && payload && typeof payload === 'object'
    && 'operation' in payload && payload.operation === 'status') return true
  if (namespace !== 'execution-v1' || !payload || typeof payload !== 'object') return false
  const fields = payload as Record<string, unknown>
  return typeof fields.method === 'string'
    && ['history', 'conversation.history', 'conversation.reconcile', 'physical-readout'].includes(fields.method)
    || fields.method === 'physical-ack' && fields.retire === true
}
