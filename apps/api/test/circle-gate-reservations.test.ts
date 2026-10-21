import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { CiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type CiCommits } from '../src/modules/ci-host/service.js'
import { CircleStandby } from '../src/modules/ci-host/circleStandby.js'
import type { HostCiComputer, HostCiEndpoint } from '../src/modules/ci-host/serviceTypes.js'

it('reserves ordinary cloud capacity on active standby orgs instead of exhausted primaries', async () => {
  const db = await migratedDatabase()
  let service: HostCiService | undefined
  try {
    const owners = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta']
    const organizations = owners.flatMap((owner, index) => Array.from({ length: 2 }, (_, slot): HostCiComputer => ({
      key: `fixture:cloud:circleci${index < 3 ? '' : '~reserve'}@${owner}:${slot}`, label: owner, priority: 10,
      hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'circleci', account: owner, slot,
        ...(index < 3 ? {} : { circleAccountId: 'reserve' }) },
    })))
    const github = Array.from({ length: 2 }, (_, slot): HostCiComputer => ({
      key: `fixture:cloud:github:${slot}`, label: 'GitHub', priority: 10,
      hostRef: { kind: 'cloud', mainId: 'fixture', provider: 'github', slot },
    }))
    await withTransaction(db.pool, client => new PostgresFoundationSettingsRepository(db.pool).updateCircleAccounts({
      accounts: [
        { id: 'default', label: 'Primary', role: 'primary', organizations: owners.slice(0, 3) },
        { id: 'reserve', label: 'Reserve', role: 'standby', organizations: owners.slice(3) },
      ],
    }, undefined, client))
    await db.pool.query("insert into workspaces(id,record) values('fixture-workspace','{}'::jsonb)")
    const groupId = randomUUID()
    const now = new Date().toISOString()
    for (let index = 0; index < 8; index++) {
      const run = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: 'fixture-workspace', groupId,
        suite: 'integration', scope: 'full',
        files: [`apps/api/test/fixture-gate-${index}.integration.test.ts`], partition: null,
        gate: true, noSupersede: true, plannedHostKey: organizations[0]!.key, integrationShards: 4,
        requiresBuildComputer: false, repository: 'fixture/source', ciMirror: 'alpha/ci-mirror', commit: 'a'.repeat(40),
        state: 'queued', computer: null, step: null, exitCode: null, message: null,
        queuedAt: now, startedAt: null, finishedAt: null, initiator: { principalId: 'fixture-operator', executionId: null },
      })
      await db.pool.query('insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,$4,$5)',
        [run.id, run.workspaceId, run.groupId, run.state, JSON.stringify(run)])
    }
    const selector = new CircleStandby(async () => owners.map((owner, index) => ({ owner,
      circleAccountId: index < 3 ? 'default' : 'reserve', role: index < 3 ? 'primary' : 'standby', ready: true,
      mirrorNames: new Set(['ci-mirror']),
    })), { reading: async owner => ({ credits: { total: 400_000,
      used: owners.indexOf(owner!) < 3 ? 400_000 : 0, remaining: owners.indexOf(owner!) < 3 ? 0 : 400_000, asOf: now,
    } }) })
    const started: string[] = []
    const endpoint: HostCiEndpoint = { computers: async () => [...github, ...organizations],
      request: async (computer, request) => {
        if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
          cpuCount: 4, memoryBytes: 16 * 2 ** 30, slotsTotal: 1, slotsUsed: 0, runs: [] }
        if (request.operation === 'start') {
          started.push(computer.key)
          return { operation: 'start', run: { runId: request.runId, state: 'running', step: 'integration',
            exitCode: null, startedAt: now, finishedAt: null, logBytes: 0, message: null } }
        }
        if (request.operation !== 'read') throw new Error('Unexpected fixture executor request')
        const result = await db.pool.query('select record from ci_runs where id=$1', [request.runId])
        const run = CiRunRecordSchema.parse(result.rows[0].record)
        return { operation: 'read', text: '', nextOffset: 0, run: { runId: run.id, state: run.state,
          step: run.step, exitCode: run.exitCode, startedAt: run.startedAt ?? now, finishedAt: run.finishedAt,
          logBytes: 0, message: run.message } }
      },
    }
    service = new HostCiService(db.pool, {} as PostgresCommandCoordinator, {} as CiAuthority, {} as CiCommits,
      endpoint, undefined, { circleStandby: selector, reservedCloudSlots: 4 })
    await service.dispatch()
    await service.drain()
    expect(started).toHaveLength(4)
    for (const owner of owners.slice(3)) expect(started.filter(key => key.includes(`@${owner}:`))).toHaveLength(1)
    expect(started.some(key => key.endsWith(':1'))).toBe(false)
    const queued = await db.pool.query("select id from ci_runs where state='queued'")
    expect(queued.rows).toHaveLength(4)
  } finally {
    await service?.close()
    await db.close()
  }
})
