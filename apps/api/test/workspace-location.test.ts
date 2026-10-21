import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import { isTransientExecutionError } from '../src/modules/runs/executionRetryPolicy.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

const principal: ManagementPrincipal = {
  id: 'principal-location', name: 'Location operator', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['workspace_locations:validate'], scope: { workspaceIds: ['workspace-1'] } }],
}

function service(runtimeRoot?: string) {
  const pool = { query: vi.fn(async () => ({ rows: [{ archived_at: null }] })) } as unknown as pg.Pool
  const commands = { recordAudit: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  return { locations: new WorkspaceLocationService(pool, commands, runtimeRoot), commands }
}

describe('local runner workspace location validation', () => {
  it('resolves spaces, Unicode and symlinks to one canonical existing directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'graphql location ü-'))
    cleanup.push(parent)
    const target = join(parent, 'project files')
    const link = join(parent, 'project-link')
    await mkdir(target)
    await symlink(target, link)
    const { locations } = service()

    const result = await locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: link, accessMode: 'read-only',
    })

    expect(result).toMatchObject({
      workspaceId: 'workspace-1', location: { runnerId: 'runner-local', rootPath: target }, accessMode: 'read-only',
    })
  })

  it('rejects relative, missing, file, unsupported-runner and NUL paths without executing anything', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'graphql-location-invalid-'))
    cleanup.push(parent)
    const file = join(parent, 'file.txt')
    await writeFile(file, 'fixture')
    const { locations } = service()

    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: 'relative', accessMode: 'read-only',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_NOT_ABSOLUTE' })
    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: join(parent, 'missing'), accessMode: 'read-only',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_NOT_FOUND' })
    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: file, accessMode: 'read-only',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_NOT_DIRECTORY' })
    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-remote', rootPath: parent, accessMode: 'read-only',
    })).rejects.toMatchObject({ code: 'RUNNER_UNSUPPORTED' })
    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: `${parent}\0bad`, accessMode: 'read-only',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_INVALID' })
  })

  it('does not require write permission for read-only validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'graphql-location-readonly-'))
    cleanup.push(directory)
    await chmod(directory, 0o500)
    const { locations } = service()
    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: directory, accessMode: 'read-only',
    })).resolves.toMatchObject({ accessMode: 'read-only' })
    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: directory, accessMode: 'read-write',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_INACCESSIBLE' })
    await chmod(directory, 0o700)
  })

  it('rejects project and managed runtime directories that contain one another', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'graphql-location-overlap-'))
    cleanup.push(parent)
    const runtime = join(parent, 'runtime')
    await mkdir(runtime)
    const { locations } = service(runtime)

    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: parent, accessMode: 'read-only',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_RUNTIME_OVERLAP' })
    await expect(locations.validate(principal, 'http', {
      workspaceId: 'workspace-1', runnerId: 'runner-local', rootPath: runtime, accessMode: 'read-only',
    })).rejects.toMatchObject({ code: 'WORKSPACE_LOCATION_RUNTIME_OVERLAP' })
  })

  it('records a placed Run location without treating a remote path as a local directory', async () => {
    const { locations } = service()
    const row = {
      execution_location: { runnerId: 'runner-remote', rootPath: '/remote/project' },
      execution_location_identity: { device: '1', inode: '2' },
      location_revision: '3', archived_at: null,
    }
    const client = { query: async () => ({ rows: [row] }) } as unknown as pg.PoolClient
    await expect(locations.snapshotAssigned(client, 'workspace-1', 3)).resolves.toMatchObject({
      ...row.execution_location, locationRevision: 3,
    })
    await expect(locations.snapshot(client, 'workspace-1', 3, 'read-only'))
      .rejects.toMatchObject({ code: 'RUNNER_UNSUPPORTED' })
    await expect(locations.snapshotAssigned(client, 'workspace-1', 2))
      .rejects.toMatchObject({ code: 'LOCATION_REVISION_CONFLICT' })
  })

  it('rejects an archived workspace even when all execution directories are placed', async () => {
    const { locations } = service()
    const client = { query: async () => ({ rows: [{ archived_at: new Date() }] }) } as unknown as pg.PoolClient
    await expect(locations.snapshotAssigned(client, 'workspace-1', 1))
      .rejects.toMatchObject({ code: 'PARENT_ARCHIVED' })
  })
})

describe('Run authorization revalidation', () => {
  it.each(['57014', '55P03', '08006'])('preserves a database %s failure for retry', async code => {
    const failure = Object.assign(new Error('Authority read unavailable'), { code })
    const client = { query: vi.fn().mockRejectedValue(failure) } as unknown as pg.PoolClient
    const { locations } = service()
    await expect(locations.revalidateRunAuthorization('owner', 'workspace', 'workflow', client)).rejects.toBe(failure)
    expect(isTransientExecutionError(failure)).toBe(true)
  })

  it('preserves a retryable domain database failure and its cause', async () => {
    const failure = new DomainError('DATABASE_READ_TIMEOUT', 'Authority read timed out', 503, { retryable: true })
    failure.cause = new Error('Query read timeout')
    const client = { query: vi.fn().mockRejectedValue(failure) } as unknown as pg.PoolClient
    await expect(service().locations.revalidateRunAuthorization('owner', 'workspace', 'workflow', client))
      .rejects.toBe(failure)
  })

  it('still rejects a confirmed missing authority', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as pg.PoolClient
    await expect(service().locations.revalidateRunAuthorization('owner', 'workspace', 'workflow', client))
      .rejects.toMatchObject({ code: 'RUN_AUTHORIZATION_REVOKED', status: 403 })
  })
})
