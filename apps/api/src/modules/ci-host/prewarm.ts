import { RetryBackoff } from '../../infrastructure/retryBackoff.js'
import { randomUUID } from 'node:crypto'
import type { CiRunRecord } from '@foreman-code/contracts'
import { componentLogger } from '../diagnostics/logger.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const log = componentLogger('jobs')

/** Preparation runs independently so a slow computer cannot hold up CI dispatch. */
export class CiPrewarm {
  private pending: Promise<void> | undefined
  private readonly delivered = new Set<string>()
  private readonly retries = new Map<string, RetryBackoff>()

  constructor(private readonly endpoint: HostCiEndpoint) {}

  schedule(computers: HostCiComputer[], runs: CiRunRecord[]): void {
    if (this.pending) return
    const commits = [...new Map(runs.filter(run => run.state === 'queued' && !run.supersededBy)
      .map(run => [`${run.repository}:${run.commit}`, run])).values()]
    if (!commits.length) {
      this.delivered.clear()
      return
    }
    const hosts = computers.filter(computer => computer.hostRef.kind !== 'cloud')
    const retained = new Set(hosts.flatMap(host => commits.map(run => `${host.key}:${run.repository}:${run.commit}`)))
    for (const key of this.delivered) if (!retained.has(key)) this.delivered.delete(key)
    this.pending = Promise.all(hosts.map(async computer => {
      const retry = this.retries.get(computer.key) ?? new RetryBackoff({ initialMs: 5000, maxMs: 300_000 })
      this.retries.set(computer.key, retry)
      if (!retry.ready()) return
      try {
        const status = await this.endpoint.request(computer, { operation: 'status' }, { priority: 'background' })
        if (status.operation !== 'status' || !status.ready || !status.prewarmSupported || status.slotsUsed
          || status.runs.some(run => ['starting', 'running'].includes(run.state))) {
          retry.reset()
          return
        }
        for (const run of commits) {
          const key = `${computer.key}:${run.repository}:${run.commit}`
          if (this.delivered.has(key)) continue
          const reply = await this.endpoint.request(computer, { operation: 'start', warmup: true,
            runId: randomUUID(), repository: run.repository, commit: run.commit, suite: 'install', scope: 'full' },
          { priority: 'background' })
          if (reply.operation !== 'start') continue
          if (reply.run.state !== 'queued') this.delivered.add(key)
          if (['queued', 'starting', 'running'].includes(reply.run.state)) break
        }
        retry.reset()
      } catch (error) {
        const nextRetryMs = retry.fail()
        log.warn({ err: error, computer: computer.key, nextRetryMs }, 'CI pre-warming unavailable; retry scheduled')
      }
    })).then(() => undefined).finally(() => { this.pending = undefined })
  }

  drain() { return this.pending }
}
