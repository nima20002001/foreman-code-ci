import { codexMcpInspectorAdapter } from '../src/modules/harnesses/codexMcpInspectorAdapter.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'

const endpoint = 'http://127.0.0.1:3000/mcp'
const inspectorFor = (manager: NativeHarnessSessionManager) => codexMcpInspectorAdapter(manager as CodexAppServerSessionManager)
const authority = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', endpoint, inspectorFor)
const signal = new AbortController().signal
afterEach(() => vi.restoreAllMocks())

describe('Operator chat installation evidence', () => {
  it('inspects the actual worker context and rejects a response from the Main directory', async () => {
    const manager: NativeHarnessSessionManager = new CodexAppServerSessionManager('unused')
    const context = { runnerId: 'device:worker', workingDirectory: '/worker/private/chat' }
    manager.mcpInspectionContext = async () => context
    let directory = context.workingDirectory
    const inspect = vi.fn(async () => ({ harness: 'codex' as const, ...context, workingDirectory: directory,
      providerVersion: 'fixture-only', inspectedAt: new Date().toISOString(), entry: { name: 'foreman-code',
        transport: 'stdio' as const, automaticEndpoint: true, enabled: true,
        credentialEnvironmentVariable: 'FOREMAN_CODE_MCP_TOKEN' } }))
    const owner = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/main/operator', endpoint,
      () => ({ inspect }))
    expect(await owner.setup(manager, signal)).toMatchObject({ status: 'configured', routing: 'automatic' })
    expect(inspect).toHaveBeenCalledWith({ harness: 'codex', ...context,
      serverName: 'foreman-code', phase: 'configuration', signal })
    directory = '/main/operator'
    await expect(owner.setup(manager, signal)).rejects.toMatchObject({ code: 'MCP_INSPECTION_CONTEXT_MISMATCH' })
  })
  it.each(['graphql', 'foreman-code'])('accepts %s for Operator setup with either supported token reference', async (serverName) => {
    for (const credentialEnvironmentVariable of ['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN']) {
      const manager = { harness: 'codex' } as NativeHarnessSessionManager
      const owner = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', endpoint,
        () => ({ inspect: async () => ({ harness: 'codex', runnerId: 'runner-local', workingDirectory: '/operator',
          providerVersion: '0.154.0', inspectedAt: new Date().toISOString(), entry: { name: serverName,
            enabled: true, transport: 'stdio', automaticEndpoint: true, credentialEnvironmentVariable } }) }))
      expect(await owner.setup(manager, signal)).toMatchObject({ status: 'configured', routing: 'automatic' })
    }
  })
  it('refuses text-mode setup before native inspection when the inspector port is unbound', async () => {
    const owner = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', endpoint)
    const manager = new CodexAppServerSessionManager('unused')
    const inspect = vi.spyOn(manager, 'inspectMcpConfiguration'), create = vi.spyOn(manager, 'createSession')
    await expect(owner.setup(manager, signal)).rejects.toMatchObject({ code: 'OPERATOR_MCP_SETUP_REQUIRED' })
    expect(inspect).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled()
  })
  it('accepts a proven Codex automatic launcher at any app port, while respecting disable', async () => {
    for (const port of [3012, 4567]) {
      const owner = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator',
        `http://127.0.0.1:${port}/mcp`, inspectorFor)
      const manager = new CodexAppServerSessionManager('unused')
      const inspect = vi.spyOn(manager, 'inspectMcpConfiguration').mockResolvedValue({
        cwd: '/operator', providerVersion: '0.154.0', serverName: 'graphql', configured: {
          enabled: true, automaticEndpoint: true, transport: 'stdio', url: null,
          bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
        },
      } as never)
      expect(await owner.setup(manager, signal)).toMatchObject({ status: 'configured' })
      inspect.mockResolvedValue({ cwd: '/operator', providerVersion: '0.154.0', serverName: 'graphql',
        configured: { enabled: false, automaticEndpoint: true } } as never)
      expect(await owner.setup(manager, signal)).toMatchObject({ status: 'setup_required' })
    }
  })
  it('reports absent Codex MCP as setup required and preserves inspection failures', async () => {
    const manager = new CodexAppServerSessionManager('unused')
    const inspect = vi.spyOn(manager, 'inspectMcpConfiguration').mockRejectedValue(new HarnessExecutionError('CODEX_MCP_NOT_CONFIGURED', 'Absent'))
    expect(await authority.setup(manager, signal)).toMatchObject({ harness: 'codex', status: 'setup_required' })
    inspect.mockRejectedValue(new Error('Inspection failed'))
    await expect(authority.setup(manager, signal)).rejects.toThrow('Inspection failed')
  })
})

it('uses the registered typed inspector for Claude without concrete manager-class routing', async () => {
  const manager = { harness: 'claude' } as NativeHarnessSessionManager
  const inspect = vi.fn(async () => ({ harness: 'claude' as const, providerVersion: '2.1.284', runnerId: 'runner-local',
    workingDirectory: '/operator', inspectedAt: '2026-10-01T00:00:00.000Z', entry: {
      name: 'graphql', transport: 'streamable-http' as const, endpoint, enabled: true,
      credentialArrangement: { kind: 'unknown' as const }, status: 'authentication_required' as const,
    } }))
  const delivery = vi.fn(async () => undefined)
  const owner = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', endpoint, () => ({ inspect }), delivery)
  expect(await owner.setup(manager, signal)).toMatchObject({ harness: 'claude', status: 'configured', routing: 'fixed' })
  expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ harness: 'claude', phase: 'configuration', signal }))
  expect(delivery).not.toHaveBeenCalled()
  const uncomposed = new PostgresOperatorChatAuthority({} as never, {} as never, {} as never, '/operator', endpoint, () => ({ inspect }))
  expect(await uncomposed.setup(manager, signal)).toMatchObject({ status: 'setup_required' })
  inspect.mockResolvedValueOnce({ ...(await inspect()), workingDirectory: '/another-actor' })
  await expect(owner.setup(manager, signal)).rejects.toMatchObject({ code: 'MCP_INSPECTION_CONTEXT_MISMATCH' })
})
