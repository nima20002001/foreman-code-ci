import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { CircleAccountDirectory } from '../src/modules/ci-host/circleAccounts.js'
import { CircleCiAccounts } from '../src/modules/ci-host/circleCiAccounts.js'
import { CloudCi } from '../src/modules/ci-host/cloud.js'
import { CircleCiProvider, GitHubActionsProvider } from '../src/modules/ci-host/cloudProviders.js'
import { CiDispatchDeadlineError, withCiDispatchDeadline } from '../src/modules/ci-host/dispatchDeadline.js'
import { ProductionHostCiEndpoint } from '../src/modules/ci-host/endpoint.js'
import type { HostCiPorts } from '../src/modules/ci-host/runner.js'
import type { HostCiComputer } from '../src/modules/ci-host/serviceTypes.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let fixture: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { fixture = await migratedDatabase() }, 60_000)
afterAll(async () => { await fixture?.close() }, 60_000)

it.each(['ended', 'expired'] as const)(
  'discovers all existing primary organizations after the dispatch pass has %s without account setup', async outcome => {
    const database = createDatabase({ connectionString: fixture.databaseUrl, maxConnections: 4, connectionTimeoutMs: 1000 })
    const settings = new PostgresFoundationSettingsRepository(database.pool)
    const registry = { list: async () => (await settings.getCircleAccounts()).value.accounts }
    const entered = deferred()
    const resumeDiscovery = deferred()
    const resumeDispatch = deferred()
    const owners = ['fixture-alpha', 'fixture-beta', 'fixture-gamma']
    let memberships = 0
    const ports: HostCiPorts = {
      now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
      run: async (file, args) => {
        if (file === 'gh' && args[0] === 'api') {
          memberships++
          entered.resolve()
          await resumeDiscovery.promise
          return { code: 0, stdout: owners.join('\n'), stderr: '' }
        }
        if (file === 'circleci' && (args[0] === 'project' || args[0] === 'auth')) {
          return { code: 0, stdout: '{}', stderr: '' }
        }
        throw new Error(`Unexpected fixture command: ${file} ${args[0]}`)
      },
    }
    const directory = new CircleAccountDirectory(ports, registry, {
      configRoot: join(fixture.directory, outcome, 'config'), environment: { CIRCLE_TOKEN: 'fixture-primary-token' },
    })
    const context = async (id: string) => {
      const account = await directory.context(id)
      if (!account) throw new Error('Fixture login is missing')
      return account
    }
    const primaryContext = await context('default')
    const primary = new CircleCiProvider(primaryContext.ports, { http: primaryContext.http })
    primary.recoveryOnly = true
    const mirrors = async () => 'fixture-alpha/site-ci'
    const clouds = [new CloudCi('fixture-main', new GitHubActionsProvider(ports), mirrors,
      join(fixture.directory, outcome, 'github')), new CloudCi('fixture-main', primary, mirrors,
      join(fixture.directory, outcome, 'recovery'))]
    const discovery = new CircleCiAccounts(ports, async () => [await mirrors()], async account => {
      const selected = await context(account.circleAccountId ?? 'default')
      clouds.push(new CloudCi('fixture-main', new CircleCiProvider(selected.ports, { http: selected.http }, account),
        mirrors, join(fixture.directory, outcome, account.owner)))
    }, { registry, context, explicitPrimary: true })
    let refreshing: Promise<void> | undefined
    const endpoint = new ProductionHostCiEndpoint(database.pool, 'fixture-main', () => undefined, {
      handle: async () => { throw new Error('Unexpected local executor request') },
    }, clouds, () => { refreshing = discovery.refresh(); return refreshing })
    let initial: HostCiComputer[] = []
    try {
      expect((await settings.getCircleAccounts()).value.accounts).toMatchObject([
        { id: 'default', role: 'primary', organizations: [] },
      ])
      const dispatch = withCiDispatchDeadline(async () => {
        initial = await endpoint.computers()
        await entered.promise
        if (outcome === 'expired') await resumeDispatch.promise
      })
      if (outcome === 'expired') await expect(dispatch).rejects.toBeInstanceOf(CiDispatchDeadlineError)
      else await dispatch
      expect(initial.every(computer => computer.hostRef.provider === 'github')).toBe(true)
      expect(initial).toHaveLength(20)
      resumeDiscovery.resolve()
      await refreshing

      const computers = await endpoint.computers()
      const circle = computers.filter(computer => computer.hostRef.provider === 'circleci')
      expect(circle).toHaveLength(90)
      expect([...new Set(circle.map(computer => computer.hostRef.account))].sort()).toEqual(owners)
      expect(circle.every(computer => computer.hostRef.circleAccountId === undefined)).toBe(true)
      for (const owner of owners) {
        const computer = circle.find(computer => computer.hostRef.account === owner)!
        expect(await endpoint.request(computer, { operation: 'status' })).toMatchObject({ operation: 'status', ready: true })
      }
      expect(memberships).toBe(1)
      expect((await settings.getCircleAccounts()).value.accounts[0]?.organizations).toEqual([])
    } finally {
      resumeDiscovery.resolve()
      resumeDispatch.resolve()
      await refreshing
      await database.close()
    }
  },
)
