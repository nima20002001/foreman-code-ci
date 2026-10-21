import { beginRuntimeTiming } from '../../infrastructure/runtimeTiming.js'
import { setTimeout as delay } from 'node:timers/promises'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { NATIVE_PRODUCER_REJECTION_TYPE } from '../run-graph/nativeProducerNormalization.js'
import { selectNativeGraphEvidence } from '../run-graph/nativeEvidence.js'
import { ignoreError } from '../diagnostics/ignoredError.js'

export const NATIVE_EVENT_BATCH_SIZE = 16
const flushIntervalMs = 25

/** Consume inside the writer lifetime so the last partial batch precedes lease release. */
export async function* nativeEventBatches(events: AsyncIterable<NativeHarnessEvent>): AsyncIterable<NativeHarnessEvent[]> {
  const iterator = events[Symbol.asyncIterator]()
  let pending: Promise<IteratorResult<NativeHarnessEvent>> | undefined
  let batch: NativeHarnessEvent[] = []
  let flushAt = 0
  try {
    for (;;) {
      pending ??= iterator.next()
      const timer = new AbortController()
      const finished = beginRuntimeTiming('harness', 'native.batch_read',
        { count: batch.length, intervalMs: flushIntervalMs })
      let next: IteratorResult<NativeHarnessEvent> | undefined
      try {
        next = batch.length ? await Promise.race([
          pending,
          delay(Math.max(0, flushAt - Date.now()), undefined, { signal: timer.signal }),
        ]) : await pending
      } catch (error) {
        if (batch.length) yield batch
        throw error
      } finally { timer.abort(); finished() }
      if (!next) {
        yield batch
        batch = []
        continue
      }
      pending = undefined
      if (next.done) {
        if (batch.length) yield batch
        return
      }
      if (!batch.length) flushAt = Date.now() + flushIntervalMs
      batch.push(next.value)
      // Provider frames acquire their execution identity at the persistence boundary.
      const evidence = selectNativeGraphEvidence(next.value.type, next.value.payload)
      const immediate = [
        NATIVE_PRODUCER_REJECTION_TYPE, 'transport.disconnected', 'interaction.pending', 'permission.asked',
      ].includes(next.value.type)
        || evidence.kind === 'invalid'
        || evidence.kind === 'evidence' && !next.value.type.startsWith('item.')
      // Ready reads fill the bounded batch; the timer race flushes a waiting read.
      if (immediate || batch.length === NATIVE_EVENT_BATCH_SIZE) {
        yield batch
        batch = []
      }
    }
  } finally {
    void pending?.catch(ignoreError('harness', 'finish pending native event read'))
    await iterator.return?.()
  }
}
