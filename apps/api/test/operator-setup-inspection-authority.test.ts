import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import { OperatorConfigurationVersionSchema, type OperatorChatSetup } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { PostgresOperatorChatAuthority } from '../src/modules/conversations/operatorChatAuthority.js'

const endpoint = 'http://127.0.0.1:3050/mcp'
const mainId = '11111111-1111-4111-8111-111111111111'
const configuration = OperatorConfigurationVersionSchema.parse({ id: 'saved-claude-config', operatorId: 'application-operator', version: 1,
  harness: { harness: 'claude', model: 'fixture-model', authMode: 'subscription', configDirectory: '/fixture/profile',
    permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'], permissionRules: [], instructions: '',
    mcpServers: { graphql: { type: 'http', url: endpoint } } },
  harnessProfileSelection: { instanceId: '22222222-2222-4222-8222-222222222222', instanceRevision: '1',
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, harnessInstallationId: 'fixture-installation', installationFingerprint: 'fixture-payload' } },
  contentHash: `sha256:${'a'.repeat(64)}`, createdAt: '2026-10-02T00:00:00Z',
})
function fixture() {
  let principal: ManagementPrincipal = { id: 'inspection-reader', name: 'Inspection reader', audience: 'operator',
    grants: [{ actions: ['harnesses:read'], scope: {} }], revokedAt: null, expiresAt: '2099-01-01T00:00:00Z' }
  const currentOperator = vi.fn(async () => principal)
  const query = vi.fn()
  const delivery = vi.fn()
  const inspect = vi.fn(async (): Promise<OperatorChatSetup> => ({ harness: 'claude', status: 'configured', endpoint, checkedAt: '2026-10-02T00:00:00Z' }))
  const authority = new PostgresOperatorChatAuthority({ query } as unknown as pg.Pool, { currentOperator, currentHarnessInspectionPrincipal: currentOperator } as unknown as PostgresAccessService,
    {} as NativeRollout, '/fixture/operator', endpoint, undefined, delivery, inspect)
  return { authority, principal, currentOperator, query, delivery, inspect, deny: () => { principal = { ...principal, grants: [] } } }
}

it('uses read-authorized configuration inspection without issuing execution or MCP credentials', async () => {
  const f = fixture()
  expect(await f.authority.setupConfiguration(f.principal, configuration, new AbortController().signal)).toMatchObject({ status: 'configured', harness: 'claude' })
  expect(f.inspect).toHaveBeenCalledWith(f.principal, configuration, expect.any(AbortSignal))
  expect(f.currentOperator).toHaveBeenCalledTimes(2)
  expect(f.query).not.toHaveBeenCalled()
  expect(f.delivery).not.toHaveBeenCalled()
})

it('denies missing or removed live read grants before inspection and after native readback', async () => {
  const f = fixture(); f.deny()
  await expect(f.authority.setupConfiguration(f.principal, configuration, new AbortController().signal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(f.inspect).not.toHaveBeenCalled()
  const changing = fixture()
  changing.inspect.mockImplementation(async () => {
    changing.deny()
    return { harness: 'claude', status: 'configured', endpoint, checkedAt: '2026-10-02T00:00:00Z' }
  })
  await expect(changing.authority.setupConfiguration(changing.principal, configuration, new AbortController().signal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
})

it.each(['harness', 'endpoint', 'configuration'] as const)('rejects %s from another native inspection context', async (fault) => {
  const f = fixture()
  f.inspect.mockResolvedValue({ harness: fault === 'harness' ? 'codex' : 'claude', status: 'configured',
    endpoint: fault === 'endpoint' ? 'http://127.0.0.1:9999/mcp' : endpoint,
    ...(fault === 'configuration' ? { configurationVersionId: 'foreign-config' } : {}), checkedAt: '2026-10-02T00:00:00Z' })
  await expect(f.authority.setupConfiguration(f.principal, configuration, new AbortController().signal)).rejects.toMatchObject({ code: 'MCP_INSPECTION_CONTEXT_MISMATCH' })
})
