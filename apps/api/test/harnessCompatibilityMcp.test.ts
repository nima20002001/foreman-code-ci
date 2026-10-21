import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessCompatibilityListSchema, HarnessCompatibilitySchema } from '@foreman-code/contracts'
import { ManagementPrincipalSchema, type ManagementAudience, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { HarnessCompatibilityService } from '../src/modules/harnesses/compatibility/service.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const resources: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close()
})

function principal(actions = ['harnesses:read', 'harnesses:update']): ManagementPrincipal {
  return ManagementPrincipalSchema.parse({ id: 'owner', name: 'Owner', audience: 'operator',
    grants: [{ actions, scope: {} }], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null })
}

async function fixture(identity = principal(), extraServices: Partial<OperatorServices> = {}) {
  const inspect = vi.fn(async (harness: 'codex') => ({
    executable: '/fake/cli', identity: harness, version: '99.0.0',
  }))
  const probe = vi.fn(async () => 'f'.repeat(64))
  const recordAudit = vi.fn(async () => undefined)
  const recordDenied = vi.fn(async () => undefined)
  const service = new HarnessCompatibilityService({
    probe: { inspect, probe, assertUnchanged: async () => undefined },
    cache: { load: async () => null, save: async () => undefined },
    commands: { recordAudit },
  })
  resources.push(() => service.close())
  const access = { authenticate: async (token: string | undefined, audience: ManagementAudience | readonly ManagementAudience[]) => {
    if (token !== 'owner-token') throw new DomainError('AUTH_REQUIRED', 'Invalid credential.', 401)
    const audiences = typeof audience === 'string' ? [audience] : audience
    if (!audiences.includes(identity.audience)) {
      throw new DomainError('AUTH_WRONG_AUDIENCE', 'The credential cannot access this endpoint.', 403)
    }
    return identity
  } } as unknown as PostgresAccessService
  const services = { ...extraServices, harnessCompatibility: service,
    commands: { recordDenied } } as unknown as OperatorServices
  const app = buildApp({ logger: false, operator: { access, services },
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
  resources.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new Client({ name: 'compatibility-test', version: '1' })
  resources.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
    authProvider: { token: async () => 'owner-token' },
  }))
  return { app, client, inspect, probe, service, recordAudit, recordDenied }
}

const listCall = { name: 'harness_compatibility_list', arguments: {} }
const retryCall = { name: 'harness_compatibility_retry', arguments: { harness: 'codex' } }

describe('compatibility through authenticated MCP', () => {
  it('requires credentials and reads status without starting a diagnostic', async () => {
    const { app, client, inspect } = await fixture()
    const payload = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    for (const headers of [{}, { authorization: 'Bearer invalid' }]) {
      expect((await app.inject({ method: 'POST', url: '/mcp', headers, payload })).statusCode).toBe(401)
    }
    const status = HarnessCompatibilityListSchema.parse(decodeMcpToolResult((await client.callTool(listCall))))
    expect(status.canRetry).toBe(true)
    expect(status.harnesses.map(report => report.harness)).toEqual(['codex'])
    expect(inspect).not.toHaveBeenCalled()
  })

  it('reads status with a read-only grant and denies retries with an audit record', async () => {
    const { client, inspect, recordDenied } = await fixture(principal(['harnesses:read']))
    const status = HarnessCompatibilityListSchema.parse(decodeMcpToolResult((await client.callTool(listCall))))
    expect(status.canRetry).toBe(false)
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain(retryCall.name)
    await expectMcpAccessDenied(client.callTool(retryCall))
    expect(recordDenied).toHaveBeenCalledWith('owner', 'mcp', retryCall.name, `mcp:${retryCall.name}`)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('accepts an authorized retry and reads its result back', async () => {
    const { client, service, recordAudit } = await fixture()
    const result = HarnessCompatibilitySchema.parse(decodeMcpToolResult((await client.callTool(retryCall))))
    expect(result).toMatchObject({ harness: 'codex', status: 'checking', scope: 'protocol-settings-diagnostic-only' })
    await service.checkAll()
    const status = HarnessCompatibilityListSchema.parse(decodeMcpToolResult((await client.callTool(listCall))))
    expect(status.harnesses[0]).toMatchObject({ harness: 'codex', installedVersion: '99.0.0', status: 'probe-passed' })
    expect(recordAudit).toHaveBeenCalledWith('owner', 'mcp', 'harness.compatibility.retry', 'codex', 'succeeded')
  })

  it('ignores caller-selected binaries and checks the installed harness', async () => {
    const { client, inspect, probe, service } = await fixture()
    const result = await client.callTool({ name: retryCall.name,
      arguments: { harness: 'codex', binary: '/arbitrary' } })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    await service.checkAll()
    expect(inspect).toHaveBeenCalledWith('codex', expect.any(AbortSignal), expect.any(Number))
    expect(probe).toHaveBeenCalledWith('codex', {
      executable: '/fake/cli', identity: 'codex', version: '99.0.0',
    }, expect.any(AbortSignal))
    const status = HarnessCompatibilityListSchema.parse(decodeMcpToolResult(await client.callTool(listCall)))
    expect(status.harnesses[0]).toMatchObject({ installedVersion: '99.0.0', status: 'probe-passed' })
  })

  it('rejects invalid harnesses before starting work', async () => {
    const { client, inspect } = await fixture()
    expect((await client.callTool({ name: retryCall.name, arguments: { harness: 'other' } })).isError).toBe(true)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects browser cookies as credentials and denies foreign origins', async () => {
    const { app, inspect } = await fixture()
    const payload = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: retryCall }
    const cookieRequest = await app.inject({ method: 'POST', url: '/mcp', payload,
      headers: { cookie: 'graphql_operator=obsolete', 'sec-fetch-site': 'cross-site' } })
    expect(cookieRequest.statusCode).toBe(401)
    const foreignRequest = await app.inject({ method: 'POST', url: '/mcp', payload,
      headers: { authorization: 'Bearer owner-token', origin: 'https://attacker.invalid' } })
    expect(foreignRequest.statusCode).toBe(403)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('denies scoped and worker credentials global harness operations', async () => {
    const scoped = principal()
    scoped.grants[0]!.scope = { workspaceIds: ['workspace-one'] }
    const reader = await fixture(scoped)
    await expectMcpAccessDenied(reader.client.callTool(listCall))
    await expectMcpAccessDenied(reader.client.callTool(retryCall))
    expect(reader.inspect).not.toHaveBeenCalled()
    await expect(fixture({ ...principal(), audience: 'worker', agentId: 'agent-one' }))
      .rejects.toThrow('The credential cannot access this endpoint.')
  })
})

it('retires unused management endpoints even when their MCP services are composed', async () => {
  const unused = vi.fn(() => { throw new Error('Retired HTTP handler invoked.') })
  const { app } = await fixture(principal(), {
    computerGitHub: { handle: unused },
    harnessInstances: { list: unused, check: unused, save: unused },
    harnessQualifications: { list: unused, run: unused },
    buildComputers: { read: unused, update: unused, updateBatch: unused },
  } as unknown as Partial<OperatorServices>)
  const paths = [
    '/api/management/computers/github/login',
    '/api/management/computers/github/login/status',
    '/api/management/computers/github/setup-git',
    '/api/management/computers/github/logout',
    '/api/management/harness-instances/read',
    '/api/management/harness-instances/save',
    '/api/management/harness-instances/check',
    '/api/management/harnesses/codex/qualification',
    '/api/management/harnesses/codex/compatibility/retry',
    '/api/management/settings/build-computers/update',
    '/api/management/settings/build-computers/batch-update',
  ]
  for (const url of paths) {
    const response = await app.inject({ method: 'POST', url,
      headers: { authorization: 'Bearer owner-token' }, payload: {} })
    expect(response.statusCode, url).toBe(404)
  }
  for (const url of ['/api/management/harnesses/qualifications', '/api/management/harnesses/compatibility']) {
    const response = await app.inject({ url, headers: { authorization: 'Bearer owner-token' } })
    expect(response.statusCode, url).toBe(400)
  }
  expect(unused).not.toHaveBeenCalled()
})
