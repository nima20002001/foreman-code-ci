import type pg from 'pg'
import { CiRunRecordSchema, type CiHostReply, type CiHostStatus, type CiRunRecord } from '@foreman-code/contracts'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { HostCiComputer } from './serviceTypes.js'

/** Cloud readiness belongs to a provider login and organization; slot occupancy is read separately. */
export function ciComputerStatusKey(computer: HostCiComputer): string {
  const host = computer.hostRef
  if (host.kind !== 'cloud') return canonicalJson(computer)
  return canonicalJson({ kind: host.kind, mainId: host.mainId, provider: host.provider,
    account: host.account?.toLowerCase() ?? '', circleAccountId: host.circleAccountId ?? 'default' })
}

/** Provider I/O is shared; database reads and reconciliation retain each caller's priority. */
export class CiComputerStatuses {
  private readonly pending = new Map<string, Promise<CiHostReply>>()

  constructor(private readonly pool: pg.Pool,
    private readonly sharedStatusKey: (computer: HostCiComputer) => string | undefined,
    private readonly reconcile: (run: CiRunRecord, computer: HostCiComputer, status: CiHostStatus | null) => Promise<void>) {}

  read(computer: HostCiComputer, send: () => Promise<CiHostReply>): Promise<CiHostReply> {
    return this.readStatus(computer, () => this.readProviderStatus(computer, send))
  }

  private readProviderStatus(computer: HostCiComputer, send: () => Promise<CiHostReply>): Promise<CiHostReply> {
    const key = this.sharedStatusKey(computer)
    if (key === undefined) return send()
    let operation = this.pending.get(key)
    if (!operation) {
      operation = send().finally(() => { this.pending.delete(key) })
      this.pending.set(key, operation)
    }
    return operation
  }

  private async readStatus(computer: HostCiComputer, send: () => Promise<CiHostReply>): Promise<CiHostReply> {
    const assigned = await this.pool.query<{ record: unknown; host_key: string }>(
      `select record,host_key from ci_runs where state in ('starting','running')`)
    const key = this.sharedStatusKey(computer)
    const targets = assigned.rows.flatMap(row => {
      if (computer.hostRef.kind !== 'cloud' && row.host_key !== computer.key) return []
      const run = CiRunRecordSchema.parse(row.record)
      if (row.host_key === computer.key) return [{ run, computer }]
      if (key === undefined || run.computer?.hostRef.kind !== 'cloud') return []
      const target = { ...computer, ...run.computer, key: row.host_key }
      return this.sharedStatusKey(target) === key ? [{ run, computer: target }] : []
    })
    let status: CiHostStatus | null = null
    try {
      const reply = await send()
      if (reply.operation === 'status') status = reply
      return reply
    } finally {
      for (const target of targets) await this.reconcile(target.run, target.computer, status)
    }
  }
}
