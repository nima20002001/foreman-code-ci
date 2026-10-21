import { afterEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { GitHubLoginRequest } from '@foreman-code/contracts/computer-accounts'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import type { PostgresAccessService } from '../access/postgres.js'
import { DeviceApplicationError, deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { ComputerGitHubService } from './github.js'
import { GitHubLoginRunner } from './githubLogin.js'
import { pairedComputerFixture } from './pairedComputer.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each([
  ['computer_github_login_status', { operation: 'login-status', loginId: '44444444-4444-4444-8444-444444444444' }, 'GITHUB_LOGIN_NOT_FOUND'],
  ['computer_github_login_start', { operation: 'login-start' }, 'GITHUB_CLI_MISSING'],
  ['computer_github_setup_git', { operation: 'setup-git', loginId: '44444444-4444-4444-8444-444444444444' }, 'GITHUB_LOGIN_NOT_FOUND'],
] as const)('preserves the public remote error for %s through authenticated MCP', async (name, request, code) => {
  const f = pairedComputerFixture()
  const runner = new GitHubLoginRunner({ now: Date.now,
    probe: { environment: {}, readText: async () => null, find: async () => null, run: async () => { throw new Error('CLI is absent') } },
    spawn: () => { throw new Error('CLI is absent') } })
  const remote = { binding: { ...f.registration }, request: async (input: GitHubLoginRequest) => {
    try { return { payload: await runner.handle(input) } } catch (error) {
      const failure = deviceApplicationFailure(error)
      throw new DeviceApplicationError(failure.code, undefined, { class: failure.class })
    }
  } }
  const computerGitHub = new ComputerGitHubService(f.pool, f.mainId,
    () => ({ captureRequest: () => remote }) as never, f.commands, { local: runner })
  const app = Fastify()
  const access = { authenticate: async (token: string) => token === 'owner' ? f.principal
    : { ...f.principal, id: 'denied', grants: [] } } as unknown as PostgresAccessService
  registerGraphqlMcp(app, { access, operator: { computerGitHub, commands: f.commands } as unknown as OperatorServices })
  const call = async (token: string, target = f.target) => {
    const argumentsForRequest = 'loginId' in request ? { loginId: request.loginId } : {}
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name,
        arguments: { target, ...argumentsForRequest } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return decodeMcpToolResult((data ? JSON.parse(data.slice(6)) : response.json()).result)
  }
  try {
    expect(await call('denied')).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const local = await computerGitHub.handle(f.principal, 'http', {
      hostRef: { kind: 'main', mainId: f.mainId }, applicationInstallationId: f.mainId,
      keyRevision: null, authorizationRevision: null,
    }, request).catch(error => ({ error: { code: error.code, message: error.message } }))
    const result = await call('owner')
    expect(result).toMatchObject({ error: { code } })
    expect(result).toMatchObject(local)
  } finally {
    await app.close()
    await f.pool.end()
  }
})
