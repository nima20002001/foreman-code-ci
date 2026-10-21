import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { loadConfig } from '../../config.js'
import { JobService } from '../jobs/service.js'
import { jobSpec } from '../../../test/helpers/jobFixture.js'
import { PostgresFoundationSettingsRepository } from './foundation.js'
import { WorkerExecutionPolicy } from './workerExecution.js'

const reader: ManagementPrincipal = {
  id: 'settings-reader',
  name: 'Settings reader',
  audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z',
  revokedAt: null,
  grants: [{ actions: ['settings:read'], scope: {} }],
}

describe('Worker execution deployment setting', () => {
  it('defaults off and leaves Main permitted', () => {
    const policy = new WorkerExecutionPolicy()
    expect(policy.read(reader)).toEqual({ enabled: false, managedBy: 'settings' })
    expect(() => policy.requireEnabled({ kind: 'main' })).not.toThrow()
    expect(() => policy.requireEnabled({ kind: 'device' })).toThrow('Execution on connected computers is disabled')
  })

  it('permits Worker execution with explicit startup opt-in', () => {
    const policy = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
    expect(() => policy.requireEnabled({ kind: 'device' })).not.toThrow()
    expect(policy.read(reader).enabled).toBe(true)
  })

  it('applies persisted execution enablement live', () => {
    const policy = new WorkerExecutionPolicy()
    policy.apply({ enabled: true, managedBy: 'settings' })
    expect(() => policy.requireEnabled({ kind: 'device' })).not.toThrow()
    expect(policy.read(reader)).toEqual({ enabled: true, managedBy: 'settings' })
    policy.apply({ enabled: false, managedBy: 'settings' })
    expect(() => policy.requireEnabled({ kind: 'device' })).toThrow()
  })

  it('requires global settings read permission', () => {
    const policy = new WorkerExecutionPolicy()
    expect(() => policy.read({ ...reader, grants: [] })).toThrow()
    expect(() => policy.read({ ...reader, grants: [
      { actions: ['settings:read'], scope: { workspaceIds: ['workspace'] } },
    ] })).toThrow()
  })

  it('parses only explicit deployment flag values', () => {
    const environment = { DATABASE_URL: 'postgresql://example:example@127.0.0.1/test' }
    expect(loadConfig(environment).workerExecution).toEqual({ enabled: false, managedBy: 'settings' })
    expect(loadConfig({ ...environment, FOREMAN_CODE_LAPTOP_EXECUTION_ENABLED: '0' }).workerExecution)
      .toEqual({ enabled: false, managedBy: 'startup' })
    expect(loadConfig({ ...environment, GRAPHQL_LAPTOP_EXECUTION_ENABLED: '1' }).workerExecution?.enabled).toBe(true)
    expect(() => loadConfig({ ...environment, GRAPHQL_LAPTOP_EXECUTION_ENABLED: 'true' })).toThrow()
  })

  it('blocks Worker Job preparation before source work and preserves Main preparation', async () => {
    const accept = vi.fn(async () => ({ prepared: true }))
    const jobs = new JobService({} as never, {} as never, {
      workerExecution: new WorkerExecutionPolicy({ enabled: false, managedBy: 'settings' }),
      preparation: { accept } as never,
      dispatch: {} as never,
      artifacts: {} as never,
    })
    const spec = jobSpec()
    const definition = { workspaceId: 'workspace', spec } as never
    const identity = { executionId: 'execution', attemptId: 'attempt', operationId: 'operation' }
    await jobs.prepareDefinition({} as never, reader, definition, identity)
    expect(accept).toHaveBeenCalledOnce()
    accept.mockClear()
    const remoteSpec = { ...spec, target: { ...spec.target, hostRef: {
      kind: 'device' as const,
      mainId: spec.target.mainId,
      deviceId: '11111111-1111-4111-8111-111111111112',
    } } }
    await expect(jobs.prepareDefinition({} as never, reader,
      { workspaceId: 'workspace', spec: remoteSpec } as never, identity))
      .rejects.toMatchObject({ code: 'WORKER_EXECUTION_DISABLED', status: 409 })
    expect(accept).not.toHaveBeenCalled()
  })
})

it('defaults missing remote execution settings off while preserving explicit saved values', async () => {
  const query = vi.fn().mockResolvedValue({ rows: [] })
  const settings = new PostgresFoundationSettingsRepository({ query } as never)
  expect((await settings.getRemoteExecutionSettings()).value.enabled).toBe(false)
  query.mockResolvedValue({ rows: [{ record: { enabled: false, listener: {
    enabled: false, host: null, port: null, certificateFile: null, privateKeyFile: null,
    advertisedEndpoint: null, trustCertificateFile: null,
  } }, revision: '1', current_version_id: 'saved' }] })
  expect(await settings.getRemoteExecutionSettings()).toMatchObject({ value: { enabled: false }, revision: 1 })
  const disabled = await settings.getRemoteExecutionSettings()
  query.mockResolvedValue({ rows: [{ record: { ...disabled.value, enabled: true },
    revision: '2', current_version_id: 'enabled' }] })
  expect(await settings.getRemoteExecutionSettings()).toMatchObject({ value: { enabled: true }, revision: 2 })
})
