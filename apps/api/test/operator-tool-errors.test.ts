import { expect, it, vi } from 'vitest'
import { invokeOperatorTool } from '../src/mcp/operator/invoke.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { registerHostHarnessOverrideTools } from '../src/modules/harnesses/instanceSettings/management.js'

const log = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('../src/infrastructure/logger.js', () => ({ componentLogger: () => log }))

function context() {
  const recordDenied = vi.fn(async () => undefined)
  return { recordDenied, value: {
    principal: { id: 'operator' }, services: { commands: { recordDenied } },
  } as unknown as OperatorRequestContext }
}

it('logs the failure location and code without exposing private error text or tool arguments', async () => {
  log.error.mockClear()
  const error = Object.assign(new Error('private-provider-credential\nprivate-multiline-credential'), {
    code: 'CLI_CHECK_REJECTED',
  })
  const result = await invokeOperatorTool(context().value, 'harness_qualification_run', async () => { throw error })
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify({
    error: { code: 'INTERNAL_ERROR', message: 'The Operator service could not complete the request.' },
  }) }] })
  expect(log.error).toHaveBeenCalledOnce()
  const [diagnostic, message] = log.error.mock.calls[0]!
  expect(diagnostic).toMatchObject({ tool: 'harness_qualification_run', errorType: 'Error',
    errorCode: 'CLI_CHECK_REJECTED' })
  expect(diagnostic.stackFrames.length).toBeGreaterThan(0)
  expect(message).toBe('Operator tool failed')
  expect(JSON.stringify(diagnostic)).not.toContain('private-provider-credential')
  expect(JSON.stringify(diagnostic)).not.toContain('private-multiline-credential')
})

it('retains permission-denial audit and public domain errors', async () => {
  log.error.mockClear()
  const caller = context()
  const result = await invokeOperatorTool(caller.value, 'harness_qualification_run', async () => {
    throw new DomainError('ACCESS_DENIED', 'Required permission is missing.', 403)
  })
  expect(caller.recordDenied).toHaveBeenCalledWith('operator', 'mcp', 'harness_qualification_run',
    'mcp:harness_qualification_run')
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify({
    error: { code: 'ACCESS_DENIED', message: 'Required permission is missing.' },
  }) }] })
  expect(log.error).not.toHaveBeenCalled()
})

it('logs a recognized database exception name without exposing arbitrary database messages', async () => {
  for (const message of ['CURRENT_VERSION_INVALID', 'private-database-value', 'CURRENT_VERSION_INVALID\nprivate-value']) {
    log.error.mockClear()
    const error = Object.assign(new Error(message), { code: 'PGC02' })
    const result = await invokeOperatorTool(context().value, 'workflow_create', async () => { throw error })
    expect(result).toMatchObject({ isError: true })
    const diagnostic = log.error.mock.calls[0]![0]
    expect(diagnostic.errorCode).toBe('PGC02')
    if (message === 'CURRENT_VERSION_INVALID') {
      expect(diagnostic.databaseException).toBe('CURRENT_VERSION_INVALID')
    } else {
      expect(diagnostic).not.toHaveProperty('databaseException')
    }
    expect(JSON.stringify(diagnostic)).not.toContain('private-')
    expect(JSON.stringify(result)).not.toContain(message)
  }
})

it('logs host-profile check failures without exposing private provider text', async () => {
  log.error.mockClear()
  const failure = new Error('private-native-credential')
  let check: ((input: unknown) => Promise<unknown>) | undefined
  const server = {
    registerTool(name: string, _options: unknown, handler: (input: unknown) => Promise<unknown>) {
      if (name === 'harness_instance_check') check = handler
    },
  } as unknown as McpServer
  const service = {
    qualificationSupported: true,
    check: vi.fn(async () => { throw failure }),
  } as unknown as HostHarnessOverrideService
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator',
    revokedAt: null, expiresAt: '9999-12-31T00:00:00.000Z',
    grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }] }
  registerHostHarnessOverrideTools(server, service, principal)
  expect(check).toBeDefined()
  const result = await check!({})
  expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: JSON.stringify({
    error: { code: 'INTERNAL_ERROR', message: 'Host harness settings failed.' },
  }) }] })
  expect(log.error).toHaveBeenCalledOnce()
  const [diagnostic] = log.error.mock.calls[0]!
  expect(diagnostic).toMatchObject({ tool: 'harness_instance_check', errorType: 'Error' })
  expect(diagnostic.stackFrames.length).toBeGreaterThan(0)
  expect(JSON.stringify(diagnostic)).not.toContain('private-native-credential')
})
