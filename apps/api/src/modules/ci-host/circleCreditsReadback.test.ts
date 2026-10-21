import Fastify from 'fastify'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { CiComputersOutputSchema } from '@foreman-code/contracts'
import type { CircleCreditAllowance } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { CircleCreditUsage } from './circleCredits.js'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'
import { HostCiService, type CiCommits } from './service.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const ports: HostCiPorts = { run: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => new Date(),
  cpus: 4, memoryBytes: 2 ** 30 }
const userSystemd = { supported: true, reason: null }
const slot = (account: string | undefined, index: number, circleAccountId?: string): HostCiComputer => ({
  key: `fixture-main:cloud:circleci${circleAccountId ? `~${circleAccountId}` : ''}${account ? `@${account}` : ''}:${index}`,
  hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', ...(account ? { account } : {}), slot: index,
    ...(circleAccountId ? { circleAccountId } : {}) },
  label: `CircleCI ${account ?? 'primary'} ${index + 1}`, priority: 30, userSystemd })
const github: HostCiComputer = { key: 'fixture-main:cloud:github:0', label: 'GitHub Actions 1', priority: 30, userSystemd,
  hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'github', slot: 0 } }

it('reads the estimated CircleCI credits per org through authenticated ci_computers_list from one cached usage read', async () => {
  const requests: string[] = []
  const circleFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const json = (body: unknown) => new Response(JSON.stringify(body))
    if (url.pathname === '/api/v2/me/collaborations') {
      return json([{ id: 'org-acme', name: 'acme', slug: 'gh/acme', vcs_type: 'github' },
        { id: 'org-beta', name: 'beta', slug: 'gh/beta', vcs_type: 'github' }])
    }
    const orgId = /\/organizations\/([^/]+)\/usage_export_job/.exec(url.pathname)?.[1]
    if (init?.method === 'POST') return json({ usage_export_job_id: `job-${orgId}`, state: 'created' })
    if (url.pathname.includes('/usage_export_job/job-')) return json({ state: 'completed', download_urls: [`https://signed.example/${orgId}.csv`] })
    return new Response('PROJECT_NAME,COMPUTE_CREDITS,STORAGE_CREDITS,TOTAL_CREDITS\n'
      + `site,${url.pathname.includes('org-beta') ? 380000 : 5690},500000,${url.pathname.includes('org-beta') ? 880000 : 505690}\n`)
  }
  const allowance: CircleCreditAllowance = { defaultMonthlyCredits: 400000, accounts: {} }
  const credits = new CircleCreditUsage(() => new CloudHttp(ports, 'circleci', { fetch: circleFetch, circleToken: async () => 'fixture-token' }),
    { allowance: async () => allowance, primaryOwner: async () => null }, { pollMs: 1 })
  const endpoint: HostCiEndpoint = {
    computers: async () => [slot('acme', 0), slot('acme', 1), slot('beta', 0, 'reserve'), slot(undefined, 0), github],
    request: async () => ({ operation: 'status', ready: true, reasons: [], cpuCount: 4, memoryBytes: 2 ** 30,
      slotsUsed: 0, slotsTotal: 1, runs: [] }),
  }
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const caller: ManagementPrincipal = { id: 'fixture-reader', name: 'Fixture reader', audience: 'operator',
    grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['fixture-workspace'] } }],
    expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }
  const authority: CiAuthority = { resolve: async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'fixture-workspace' }
  } }
  const ci = new HostCiService(pool, new PostgresCommandCoordinator(pool), authority, {} as CiCommits, endpoint,
    undefined, { circleCredits: credits })
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token =>
    token === 'reader' ? caller : { ...caller, id: 'fixture-denied', grants: [] })
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: { ci,
    commands: { recordDenied: async () => undefined } } as unknown as OperatorServices })
  const call = async (token: string) => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_computers_list',
        arguments: { workspaceId: 'fixture-workspace' } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return data ? JSON.parse(data.slice(6)) : response.json()
  }
  const list = async () => CiComputersOutputSchema.parse(decodeMcpToolResult((await call('reader')).result)).computers
  try {
    const denied = await call('denied')
    expect(denied.result?.isError ?? Boolean(denied.error)).toBe(true)
    const first = await list()
    expect(first.find(computer => computer.label === 'CircleCI acme 1')).toMatchObject({ credits: null,
      creditsUnavailable: expect.any(String) })
    await vi.waitFor(async () => {
      expect((await list()).find(computer => computer.label === 'CircleCI acme 1')?.credits).toMatchObject(
        { total: 400000, used: 5690, remaining: 394310 })
    })
    const computers = await list()
    for (const label of ['CircleCI acme 1', 'CircleCI acme 2']) {
      expect(computers.find(computer => computer.label === label)?.credits).toMatchObject({ remaining: 394310 })
    }
    // Each org's rows carry that org's own usage against its own 400,000 credits.
    expect(computers.find(computer => computer.label === 'CircleCI beta 1')?.credits).toMatchObject(
      { total: 400000, used: 380000, remaining: 20000 })
    expect(computers.find(computer => computer.label === 'CircleCI beta 1')?.hostRef.circleAccountId).toBe('reserve')
    // The primary org's owner is unknown here, and GitHub Actions has no CircleCI credits.
    expect(computers.find(computer => computer.label === 'CircleCI primary 1')).toMatchObject({ credits: null })
    expect(computers.find(computer => computer.label === 'GitHub Actions 1')).not.toHaveProperty('credits')
    expect(requests.filter(request => request.startsWith('POST'))).toHaveLength(2)
  } finally {
    await ci.close()
    await app.close()
  }
})
