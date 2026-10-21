import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { CircleStandby, circleOrgKey } from './circleStandby.js'
import { CircleCiAccounts } from './circleCiAccounts.js'
import { circleOrganizations } from './circleOrganizations.js'
import { reservedCloudSlotKeys } from './cloudSlots.js'
import type { CloudAccount } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'
import type { HostCiComputer } from './serviceTypes.js'
import { ProductionHostCiEndpoint } from './endpoint.js'
import { CloudCi } from './cloud.js'
import { CircleCiProvider } from './cloudProviders.js'
import type { CircleAccountRegistry } from './circleAccounts.js'
import type pg from 'pg'

it('runs a further CircleCI org as its own slots on its own copy of the workspace mirror', async () => {
  const f = await fixture({}, { account: 'org2' })
  const computers = f.cloud.computers()
  expect(computers).toHaveLength(30)
  expect(computers[0]).toMatchObject({ key: 'main-1:cloud:circleci@org2:0', label: 'CircleCI org2 1',
    hostRef: { kind: 'cloud', mainId: 'main-1', provider: 'circleci', account: 'org2', slot: 0 } })
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(), repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  const project = f.circle.triggered[0]!
  expect(project[project.indexOf('--project') + 1]).toBe('gh/org2/site-ci')
  expect(f.accountMirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toContain(`refs/heads/ci/${f.commit}`)
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
})

it('offers no slots and refuses a start on a CircleCI org that no longer has a copy of the workspace mirror', async () => {
  const f = await fixture({}, { account: 'org2' })
  f.account!.mirrorNames.clear()
  expect(f.cloud.computers()).toEqual([])
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .rejects.toMatchObject({ code: 'CI_CLOUD_UNAVAILABLE' })
  expect(f.circle.triggered).toEqual([])
})

function discoveryPorts(projects: Set<string>, owners = 'octo\norg2\norg3\n', broken = new Set<string>()) {
  const calls: string[] = []
  const ports: HostCiPorts = { now: () => new Date(), cpus: 1, memoryBytes: 2 ** 30, run: async (file, args) => {
    calls.push(`${file} ${args.join(' ')}`)
    if (file === 'gh') return { code: 0, stdout: owners, stderr: '' }
    if (file === 'circleci' && args[0] === 'auth') return { code: 0, stdout: '{}', stderr: '' }
    const slug = args[args.indexOf('--project') + 1]!
    if (broken.has(slug)) return { code: 1, stdout: '', stderr: 'permission denied' }
    return projects.has(slug) ? { code: 0, stdout: '{}', stderr: '' }
      : { code: 1, stdout: '', stderr: `{"code":"project.not_found","message":"No project found for \\"${slug}\\"."}` }
  } }
  return { ports, calls }
}

it('adds each GitHub organization of Main whose CircleCI project copies a workspace mirror, once', async () => {
  const projects = new Set(['gh/org2/site-ci'])
  const { ports, calls } = discoveryPorts(projects)
  const added: CloudAccount[] = []
  const accounts = new CircleCiAccounts(ports, async () => ['octo/site-ci'], account => added.push(account))
  await accounts.refresh()
  expect(added.map(account => [account.owner, [...account.mirrorNames]])).toEqual([['org2', ['site-ci']]])
  // The workspace mirror's own owner is the primary CircleCI service, never a further org.
  expect(calls.some(call => call.includes('gh/octo/'))).toBe(false)
  calls.length = 0
  await accounts.refresh()
  expect(calls).toEqual([])
})

it('keeps a known CircleCI org when discovery fails and stops its starts when its project is gone', async () => {
  const projects = new Set(['gh/org2/site-ci'])
  const { ports } = discoveryPorts(projects)
  const added: CloudAccount[] = []
  let now = 0
  const accounts = new CircleCiAccounts(ports, async () => ['octo/site-ci'], account => added.push(account), { now: () => now })
  await accounts.refresh()
  projects.clear()
  now += 11 * 60_000
  await accounts.refresh()
  expect(added).toHaveLength(1)
  expect([...added[0]!.mirrorNames]).toEqual([])
  const failing: HostCiPorts = { ...ports, run: async () => ({ code: 1, stdout: '', stderr: 'network down' }) }
  const broken = new CircleCiAccounts(failing, async () => ['octo/site-ci'], account => added.push(account))
  await expect(broken.refresh()).resolves.toBeUndefined()
  expect(added).toHaveLength(1)
})

it('adds later CircleCI orgs when one org lookup fails, and restores orgs holding unfinished runs', async () => {
  const { ports } = discoveryPorts(new Set(['gh/org3/site-ci']), 'octo\norg2\norg3\n', new Set(['gh/org2/site-ci']))
  const added: CloudAccount[] = []
  const accounts = new CircleCiAccounts(ports, async () => ['octo/site-ci'], account => added.push(account),
    { runningOwners: async () => ['org9'] })
  await accounts.refresh()
  expect(added.map(account => [account.owner, [...account.mirrorNames]])).toEqual([['org9', []], ['org3', ['site-ci']]])
})

it('keeps non-gate cloud capacity in every CircleCI org', () => {
  const slots = (provider: 'github' | 'circleci', account?: string): HostCiComputer[] =>
    Array.from({ length: 3 }, (_, slot) => ({ key: `main:${provider}${account ?? ''}:${slot}`, label: provider, priority: 30,
      hostRef: { kind: 'cloud', mainId: 'main', provider, ...(account ? { account } : {}), slot } }))
  const reserved = reservedCloudSlotKeys([...slots('github'), ...slots('circleci'), ...slots('circleci', 'org2')], 3)
  expect([...reserved].sort()).toEqual(['main:circleci:2', 'main:circleciorg2:2', 'main:github:2'])
})

it('publishes the workspace mirror without waiting for a further CircleCI org to copy it', async () => {
  const published: string[] = []
  const cloud = (account?: string) => ({ provider: account ? { account: { owner: account } } : {},
    publishMirror: () => new Promise<void>(resolve => {
      published.push(account ?? 'primary')
      // The org's copy never finishes.
      if (!account) resolve()
    }) })
  const endpoint = new ProductionHostCiEndpoint({} as pg.Pool, 'main', () => undefined, { handle: async () => { throw new Error('unused') } },
    [cloud(), cloud('org2')] as unknown as CloudCi[])
  await endpoint.publishMirror({ repository: 'octo/site', mirror: 'octo/site-ci', commit: 'a'.repeat(40) })
  expect(published.sort()).toEqual(['org2', 'primary'])
})

it('discovers explicitly bound standby projects without consulting primary GitHub memberships', async () => {
  const commands: string[] = []
  const primary = discoveryPorts(new Set())
  const reserve: HostCiPorts = { ...primary.ports, run: async (file, args) => {
    commands.push(`${file} ${args.join(' ')}`)
    return { code: 0, stdout: '{}', stderr: '' }
  } }
  const added: CloudAccount[] = []
  const discovery = new CircleCiAccounts(primary.ports, async () => ['alpha/site-ci'], org => added.push(org), {
    registry: { list: async () => [
      { id: 'default', label: 'Primary', role: 'primary', organizations: ['alpha', 'beta', 'gamma'] },
      { id: 'reserve', label: 'Reserve', role: 'standby', organizations: ['delta', 'epsilon', 'zeta'] },
    ] },
    context: async id => ({ ports: id === 'reserve' ? reserve : primary.ports }),
    runningOrganizations: async () => [{ owner: 'retired', circleAccountId: 'reserve' }],
  })
  await discovery.refresh()
  expect(added.filter(org => org.circleAccountId === 'reserve').map(org => org.owner))
    .toEqual(['retired', 'delta', 'epsilon', 'zeta'])
  expect(commands.filter(command => command.includes('project get'))).toHaveLength(3)
  expect(primary.calls.some(command => command.startsWith('gh '))).toBe(false)
  expect(new Set(added.map(org => `${org.circleAccountId ?? 'default'}:${org.owner.toLowerCase()}`)).size).toBe(7)
})

it('retries constructing a configured executor after its account context becomes available', async () => {
  const { ports } = discoveryPorts(new Set(['gh/alpha/site-ci']))
  const added: CloudAccount[] = []
  let now = 0
  let unavailable = true
  const discovery = new CircleCiAccounts(ports, async () => ['alpha/site-ci'], account => {
    if (unavailable) throw new Error('Account context is temporarily unavailable.')
    added.push(account)
  }, { now: () => now, context: async () => ({ ports }), registry: { list: async () => [
    { id: 'default', label: 'Primary', role: 'primary', organizations: ['alpha', 'beta', 'gamma'] },
  ] } })
  await discovery.refresh()
  expect(added).toEqual([])
  unavailable = false
  now += 10 * 60_000
  await discovery.refresh()
  expect(added.map(account => account.owner)).toEqual(['alpha', 'beta', 'gamma'])
  expect([...added[0]!.mirrorNames]).toEqual(['site-ci'])
})

it('restores a recovered standby organization’s registered role before overflow selection and UTC reset', async () => {
  const { ports } = discoveryPorts(new Set(['gh/alpha/site-ci', 'gh/delta/site-ci']))
  const added: CloudAccount[] = []
  const discovery = new CircleCiAccounts(ports, async () => ['alpha/site-ci'], account => added.push(account), {
    registry: { list: async () => [
      { id: 'default', label: 'Primary', role: 'primary', organizations: ['alpha', 'beta', 'gamma'] },
      { id: 'reserve', label: 'Reserve', role: 'standby', organizations: ['delta', 'epsilon', 'zeta'] },
    ] },
    context: async () => ({ ports }),
    runningOrganizations: async () => [{ owner: 'delta', circleAccountId: 'reserve' }],
  })
  await discovery.refresh()
  let now = Date.parse('2026-10-31T23:59:59Z')
  const selector = new CircleStandby(async () => added.map(account => ({
    owner: account.owner, circleAccountId: account.circleAccountId ?? 'default', role: account.role ?? 'primary',
    ready: true, mirrorNames: account.mirrorNames,
  })), { reading: async owner => now >= Date.parse('2026-11-01T00:00:00Z') ? { credits: null } : {
    credits: { total: 400_000, used: owner === 'alpha' ? 380_000 : 0,
      remaining: owner === 'alpha' ? 20_000 : 400_000, asOf: new Date(now).toISOString() },
  } }, undefined, () => now)
  await selector.recordCreditRefusal('alpha')
  expect((await selector.roles('site-ci')).get(circleOrgKey('delta', 'reserve'))?.schedulingRole).toBe('active')
  now += 1000
  expect((await selector.roles('site-ci')).get(circleOrgKey('delta', 'reserve'))?.schedulingRole).toBe('active')
  now += 5 * 60_000
  expect(await selector.admitStart('alpha', 'default', 'site-ci', 'probe')).toBe(true)
  await selector.recordCreditAcceptance('alpha', 'default', 'probe')
  expect((await selector.roles('site-ci')).get(circleOrgKey('delta', 'reserve'))?.schedulingRole).toBe('standby')
  expect(added.find(account => account.owner === 'delta')?.role).toBe('standby')
})

it('discovers the implicit primary organizations through the selected primary profile context', async () => {
  const ambient = discoveryPorts(new Set(), 'fixture-primary\n')
  const selected = discoveryPorts(new Set(['gh/fixture-primary/site-ci']))
  const added: CloudAccount[] = []
  const accounts = new CircleCiAccounts(ambient.ports, async () => ['fixture-primary/site-ci'], org => added.push(org), {
    registry: { list: async () => [{ id: 'default', label: 'Primary', role: 'primary', organizations: [] }] },
    context: async () => ({ ports: selected.ports }), explicitPrimary: true,
  })
  await accounts.refresh()
  expect(added).toMatchObject([{ owner: 'fixture-primary', circleAccountId: 'default', role: 'primary' }])
  expect([...added[0]!.mirrorNames]).toEqual(['site-ci'])
  expect(selected.calls).toContain('circleci project get --project gh/fixture-primary/site-ci --json')
  expect(ambient.calls.filter(call => call.startsWith('circleci '))).toEqual([])
})

it('keeps implicit primary discovery alongside explicit standby bindings without duplicating visible owners', async () => {
  const ambient = discoveryPorts(new Set(), 'alpha\ndelta\nepsilon\nzeta\n')
  const broken = new Set<string>()
  const primary = discoveryPorts(new Set(['gh/alpha/site-ci', 'gh/delta/site-ci']), '', broken)
  const standby = discoveryPorts(new Set(['gh/delta/site-ci', 'gh/epsilon/site-ci', 'gh/zeta/site-ci']))
  const added: CloudAccount[] = []
  const accounts = new CircleCiAccounts(ambient.ports, async () => ['alpha/site-ci'], org => added.push(org), {
    registry: { list: async () => [
      { id: 'default', label: 'Primary', role: 'primary', organizations: [] },
      { id: 'reserve', label: 'Reserve', role: 'standby', organizations: ['delta', 'epsilon', 'zeta'] },
    ] },
    context: async id => ({ ports: id === 'default' ? primary.ports : standby.ports }), explicitPrimary: true,
  })
  await accounts.refresh()
  expect(added.filter(org => org.circleAccountId === 'default').map(org => org.owner)).toEqual(['alpha'])
  expect(added.filter(org => org.circleAccountId === 'reserve').map(org => org.owner))
    .toEqual(['delta', 'epsilon', 'zeta'])
  expect(primary.calls).toEqual(['circleci project get --project gh/alpha/site-ci --json'])
  expect(ambient.calls.filter(call => call.startsWith('circleci '))).toEqual([])
  const original = added.find(org => org.owner === 'alpha')!
  broken.add('gh/alpha/site-ci')
  accounts.invalidate()
  await accounts.refresh()
  expect(added.filter(org => org.owner === 'alpha')).toHaveLength(1)
  expect(original.registered).not.toBe(false)
  expect([...original.mirrorNames]).toEqual(['site-ci'])
})

it('retires an already discovered primary executor when its organization is bound to standby', async () => {
  const { ports } = discoveryPorts(new Set([
    'gh/alpha/site-ci', 'gh/Delta/site-ci', 'gh/delta/site-ci',
    'gh/epsilon/site-ci', 'gh/zeta/site-ci',
  ]), 'alpha\nDelta\n')
  const registry: Awaited<ReturnType<CircleAccountRegistry['list']>> = [
    { id: 'default', label: 'Primary', role: 'primary', organizations: [] },
  ]
  const clouds: CloudCi[] = []
  const discovery = new CircleCiAccounts(ports, async () => ['alpha/site-ci'], account => {
    const provider = new CircleCiProvider(ports, { circleToken: async () => 'fixture-token' }, account)
    clouds.push(new CloudCi('fixture-main', provider, async () => 'alpha/site-ci'))
  }, { registry: { list: async () => registry }, context: async () => ({ ports }), explicitPrimary: true })
  await discovery.refresh()
  const original = clouds.find(cloud => cloud.provider.account?.owner === 'Delta')!
  expect(original.computers()).toHaveLength(30)

  registry.push({ id: 'reserve', label: 'Reserve', role: 'standby', organizations: ['delta', 'epsilon', 'zeta'] })
  discovery.invalidate()
  await discovery.refresh()
  await Promise.all(clouds.map(cloud => cloud.ready()))

  const organizations = await circleOrganizations(clouds)
  expect(organizations.map(org => [org.circleAccountId, org.owner, org.role])).toEqual([
    ['default', 'alpha', 'primary'], ['reserve', 'delta', 'standby'],
    ['reserve', 'epsilon', 'standby'], ['reserve', 'zeta', 'standby'],
  ])
  const selector = new CircleStandby(async () => organizations, { reading: async () => ({ credits: null }) })
  expect([...(await selector.roles('site-ci')).values()].filter(org => org.schedulingRole === 'active'))
    .toHaveLength(1)
  expect(original.computers()).toEqual([])
  expect(original.provider.account?.registered).toBe(false)
  expect(clouds).toContain(original)
  expect(original.provider.account?.owner).toBe('Delta')
})
