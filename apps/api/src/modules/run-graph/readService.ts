import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { graphJsonBytes } from '@foreman-code/contracts/wave25'
import { RepeatGraphReadService, type RunGraphReadApi } from './repeatReadService.js'
import { RunGraphError } from './errors.js'
import { observeGraph, type GraphMeasurementSink } from './measurements.js'

export type { RunGraphReadApi }

/** One canonical current reader through the PRIMARY pool. Read qualification
 * never enables native admission, Stop settlement or executable edits. */
export class RunGraphReadService implements RunGraphReadApi {
  private readonly reader: RepeatGraphReadService
  constructor(primaryPool: pg.Pool, private readonly options: { qualifiedReads?: boolean; measurements?: GraphMeasurementSink } = {}) {
    this.reader = new RepeatGraphReadService(primaryPool, { qualifiedReads: options.qualifiedReads === true })
  }
  capabilities(principal: ManagementPrincipal) { return this.reader.capabilities(principal) }
  current(principal: ManagementPrincipal, request: unknown) {
    return this.measured('snapshot', () => this.reader.current(principal, request))
  }
  snapshot(principal: ManagementPrincipal, request: unknown) {
    return this.measured('snapshot', () => this.reader.snapshot(principal, request))
  }
  events(principal: ManagementPrincipal, request: unknown) {
    return this.measured('delta', () => this.reader.events(principal, request))
  }
  private async measured<T>(stage: 'snapshot' | 'delta', work: () => Promise<T>): Promise<T> {
    const start = performance.now()
    try {
      const value = await work()
      observeGraph(this.options.measurements, { stage, outcome: 'ok', durationMs: performance.now() - start, bytes: graphJsonBytes(value) })
      return value
    } catch (error) {
      observeGraph(this.options.measurements, { stage, outcome: 'error', durationMs: performance.now() - start })
      throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
  }
}
