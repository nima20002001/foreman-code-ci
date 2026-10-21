import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import Fastify from 'fastify'
import { afterEach, expect, it, vi } from 'vitest'
import { CiComputersOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { buildComputerIntegrationShards } from './capacity.js'
import { ProductionHostCiEndpoint } from './endpoint.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'
import { HostCiService, type CiCommits } from './service.js'

const gib = 2 ** 30
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function runnerFixture() {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'ci-allowance-'))
  roots.push(root)
  const ports: HostCiPorts = { cpus: 16, memoryBytes: 32 * gib,
    availableMemoryBytes: () => 30 * gib, now: () => new Date(),
    run: async () => ({ code: 0, stdout: '', stderr: '' }) }
  return new HostCiRunner(root, ports, {})
}

it.each([false, true])('bounds public status resources by allowance with cleanup=%s', async cleanup => {
  const runner = await runnerFixture()
  const status = await runner.handle({ operation: 'status', buildAllowancePercent: 38,
    ...(cleanup ? { cleanupRunIds: [] } : {}) })
  expect(status).toMatchObject({ operation: 'status', buildAllowancePercent: 38,
    cpuCount: 6, memoryBytes: Math.floor(32 * gib * 0.38),
    availableMemoryBytes: Math.floor(32 * gib * 0.38), slotsTotal: 1, slotsUsed: 0 })
  if (status.operation !== 'status') throw new Error('Expected status')
  expect(buildComputerIntegrationShards(status, 38)).toBe(6)
})

it('keeps full capacity when no status allowance is supplied', async () => {
  const runner = await runnerFixture()
  expect(await runner.handle({ operation: 'status' })).toMatchObject({
    cpuCount: 16, memoryBytes: 32 * gib, availableMemoryBytes: 30 * gib, slotsTotal: 2,
  })
})

it('reads saved allowance and allowed CPUs through authenticated ci_computers_list', async () => {
  const runner = await runnerFixture()
  const target = { hostRef: { kind: 'main', mainId: 'fixture-main' },
    applicationInstallationId: 'fixture-main', keyRevision: null, authorizationRevision: null }
  const pool = { query: async (sql: string) => {
    if (sql.includes('from build_computer_preferences')) return { rows: [{ host_key: 'fixture-main:main',
      target, build_enabled: true, build_priority: 50, build_allowance_percent: 38 }] }
    if (sql.includes('from application_installation')) return { rows: [{ id: 'fixture-main' }] }
    return { rows: [] }
  } } as unknown as pg.Pool
  const endpoint = new ProductionHostCiEndpoint(pool, 'fixture-main', () => undefined, runner)
  const caller: ManagementPrincipal = { id: 'fixture-reader', name: 'Fixture reader', audience: 'operator',
    grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['fixture-workspace'] } }],
    expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }
  const authority: CiAuthority = { resolve: async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'fixture-workspace' }
  } }
  const commands = new PostgresCommandCoordinator(pool)
  const ci = new HostCiService(pool, commands, authority, {} as CiCommits, endpoint)
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
  try {
    const denied = await call('denied')
    expect(denied.result?.isError ?? Boolean(denied.error)).toBe(true)
    const output = CiComputersOutputSchema.parse(decodeMcpToolResult((await call('reader')).result))
    expect(output.computers).toHaveLength(1)
    expect(output.computers[0]).toMatchObject({ buildAllowancePercent: 38, allowedCpuCount: 6,
      cpuCount: 6, memoryBytes: Math.floor(32 * gib * 0.38), slotsTotal: 1, slotsUsed: 0 })
  } finally {
    await ci.close()
    await app.close()
    await runner.beginDrain()
  }
})
