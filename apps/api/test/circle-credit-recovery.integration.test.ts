import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { CircleStandby } from '../src/modules/ci-host/circleStandby.js'
import { CircleCreditCache } from '../src/modules/ci-host/circleCreditCache.js'
import { HostCiService, type CiCommits } from '../src/modules/ci-host/service.js'
import type { HostCiComputer, HostCiEndpoint } from '../src/modules/ci-host/serviceTypes.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { CiAuthority } from '../src/modules/jobs/ciAuthority.js'

it('offers one probe slot to the dispatcher while preserving replacement slots', async () => {
  const db = await migratedDatabase()
  let service: HostCiService | undefined
  try {
    await withTransaction(db.pool, client => new PostgresFoundationSettingsRepository(db.pool).updateCircleAccounts({
      accounts: [
        { id: 'default', label: 'Primary', role: 'primary', organizations: ['alpha', 'beta', 'gamma'] },
        { id: 'reserve', label: 'Reserve', role: 'standby', organizations: ['delta', 'epsilon', 'zeta'] },
      ],
    }, undefined, client))
    await db.pool.query("insert into workspaces(id,record) values('fixture-workspace','{}'::jsonb)")
    let now = Date.now()
    const organizations = [
      { owner: 'alpha', circleAccountId: 'default', role: 'primary' as const, ready: true, mirrorNames: new Set(['site-ci']) },
      { owner: 'delta', circleAccountId: 'reserve', role: 'standby' as const, ready: true, mirrorNames: new Set(['site-ci']) },
    ]
    const policy = new CircleStandby(async () => organizations, { reading: async () => ({ credits: null }) },
      new CircleCreditCache(), () => now)
    await policy.recordCreditRefusal('alpha')
    now += 5 * 60_000
    await policy.roles()
    await policy.roles('site-ci')
    const computers: HostCiComputer[] = organizations.flatMap(org => [0, 1, 2].map(slot => ({
      key: `fixture:cloud:circleci${org.circleAccountId === 'default' ? '' : '~reserve'}@${org.owner}:${slot}`,
      label: `Fixture CircleCI ${org.owner} ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider: 'circleci' as const,
        account: org.owner, circleAccountId: org.circleAccountId, slot },
    })))
    for (let index = 0; index < 6; index++) {
      const run = CiRunRecordSchema.parse({ id: randomUUID(), groupId: randomUUID(), workspaceId: 'fixture-workspace',
        suite: 'lint', scope: 'full', repository: 'fixture/source', ciMirror: 'alpha/site-ci', commit: 'a'.repeat(40),
        state: 'queued', computer: null, step: null, exitCode: null, message: null, partition: null,
        queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
        initiator: { principalId: 'fixture-operator', executionId: null },
      })
      await db.pool.query('insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,$4,$5)',
        [run.id, run.workspaceId, run.groupId, run.state, JSON.stringify(run)])
    }
    const started: HostCiComputer[] = []
    const endpoint: HostCiEndpoint = { computers: async () => computers, request: async (computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 4, memoryBytes: 16 * 2 ** 30, slotsTotal: 1, slotsUsed: 0, runs: [] }
      if (request.operation === 'start') {
        started.push(computer)
        return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'lint',
          exitCode: null, startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null } }
      }
      throw new Error(`Unexpected fixture request: ${request.operation}`)
    } }
    service = new HostCiService(db.pool, {} as PostgresCommandCoordinator, {} as CiAuthority,
      {} as CiCommits, endpoint, undefined, { circleStandby: policy })
    await service.dispatch()
    await service.drain()
    expect(started.filter(computer => computer.hostRef.account === 'alpha')).toHaveLength(1)
    expect(started.filter(computer => computer.hostRef.account === 'delta')).toHaveLength(3)
    const saved = (await db.pool.query('select record from ci_runs')).rows.map(row => CiRunRecordSchema.parse(row.record))
    expect(saved.filter(run => run.computer?.hostRef.account === 'alpha')).toHaveLength(1)
    expect(saved.filter(run => run.computer?.hostRef.account === 'delta')).toHaveLength(3)
  } finally {
    await service?.close()
    await db.close()
  }
})
