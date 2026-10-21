import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessMcpSettingsService } from './mcpSettings.js'
import type { NativeMcpSnapshot } from './nativeMcpCommon.js'

const principal: ManagementPrincipal = {
  id: 'owner',
  name: 'Owner',
  audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z',
  revokedAt: null,
  grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
}
const revision = `sha256:${'a'.repeat(64)}`

function fixture(status: 'pending' | 'uncertain' = 'uncertain') {
  const row = {
    id: randomUUID(),
    harness: 'opencode' as const,
    revision,
    change: { kind: 'remove' as const, name: 'saved-server' },
    managed_preset: null,
    requested_by: principal.id,
    status,
    created_at: new Date('2026-10-01T00:00:00Z'),
    expires_at: new Date('2026-10-01T00:10:00Z'),
    error: 'The native write may have completed.',
    native_user_after_hash: revision,
    native_file: '/historical/user-config',
  }
  const query = vi.fn()
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
  const client = { query: vi.fn(), release: vi.fn() }
  const adapter = { read: vi.fn(), apply: vi.fn() }
  const commands = { execute: vi.fn() }
  const service = new HarnessMcpSettingsService({ query, connect: async () => client } as never,
    commands as never, { codex: adapter }, vi.fn())
  return { row, query, client, adapter, commands, service }
}

it('reads a retired MCP plan with its saved status, error, change and dates', async () => {
  const { service, row, adapter } = fixture()
  expect(await service.get(principal, row.id)).toEqual({
    id: row.id,
    harness: 'opencode',
    revision: row.revision,
    change: row.change,
    managedPreset: null,
    requestedBy: row.requested_by,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    error: row.error,
    retirementMessage: RETIRED_OPENCODE_MESSAGE,
  })
  expect(adapter.read).not.toHaveBeenCalled()
  expect(adapter.apply).not.toHaveBeenCalled()
})

it.each([true, false])('rejects a decision on a retired plan when approve is %s', async approve => {
  const { service, row, client, adapter } = fixture('pending')
  client.query
    .mockResolvedValueOnce({ rows: [{ grants: principal.grants, expires_at: new Date(principal.expiresAt) }] })
    .mockResolvedValueOnce({ rows: [{ locked: true }] })
    .mockResolvedValueOnce({ rows: [row] })
    .mockResolvedValueOnce({ rows: [] })
  await expect(service.decide(principal, row.id, approve))
    .rejects.toMatchObject({ code: 'HARNESS_RETIRED', message: RETIRED_OPENCODE_MESSAGE })
  expect(adapter.read).not.toHaveBeenCalled()
  expect(adapter.apply).not.toHaveBeenCalled()
  expect(row.status).toBe('pending')
  expect(client.release).toHaveBeenCalledOnce()
})

it('rejects reconciliation of a retired plan before accepting a command or opening its native configuration', async () => {
  const { service, row, adapter, commands } = fixture()
  await expect(service.reconcile(principal, { planId: row.id, commandId: 'retired-plan-reconciliation',
    expectedRevision: revision, acceptObservedState: true }))
    .rejects.toMatchObject({ code: 'HARNESS_RETIRED', message: RETIRED_OPENCODE_MESSAGE })
  expect(commands.execute).not.toHaveBeenCalled()
  expect(adapter.read).not.toHaveBeenCalled()
  expect(adapter.apply).not.toHaveBeenCalled()
})

it('does not turn a retired idempotency receipt into an accepted managed application result', async () => {
  const { service, row, adapter } = fixture()
  const saved = await service.get(principal, row.id)
  vi.spyOn(service, 'planManaged').mockResolvedValue({ value: saved, replayed: true })
  const decide = vi.spyOn(service, 'decide')
  await expect(service.applyManaged(principal, { harness: 'codex', preset: 'graphql', installed: true,
    commandId: 'original-managed-command', expectedRevision: revision }))
    .rejects.toMatchObject({ code: 'HARNESS_RETIRED', message: RETIRED_OPENCODE_MESSAGE })
  expect(decide).not.toHaveBeenCalled()
  expect(adapter.apply).not.toHaveBeenCalled()
})

it('continues to deny retired plan readback to a caller without grants', async () => {
  const { service, row, query } = fixture()
  await expect(service.get({ ...principal, grants: [] }, row.id)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  expect(query).not.toHaveBeenCalled()
})

it('keeps a pre-write inspection from replacing the fresh list after an approved write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-write-cache-'))
  let service: HarnessMcpSettingsService | undefined
  let finishBackground: (() => void) | undefined
  try {
    const file = join(directory, 'config.toml')
    await writeFile(file, '')
    const snapshot: NativeMcpSnapshot = { harness: 'codex', revision, file, version: '1',
      userConfig: {}, user: {}, effective: {} }
    const updated = { ...snapshot, revision: `sha256:${'b'.repeat(64)}`,
      user: { added: { command: 'added', enabled: true } },
      effective: { added: { command: 'added', enabled: true } } }
    const row = { ...fixture('pending').row, harness: 'codex',
      change: { kind: 'add', name: 'added', connection: { transport: 'stdio', executable: '/usr/bin/added', arguments: [],
        environmentVariables: [] } }, expires_at: new Date('2099-01-01T00:00:00Z') }
    const liveWriter = { rows: [{ grants: principal.grants, expires_at: new Date(principal.expiresAt) }] }
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce(liveWriter)
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(liveWriter)
      .mockResolvedValueOnce({ rows: [{ ...row, status: 'submitting' }] })
    const client = { query, release: vi.fn() }
    const pool = { connect: async () => client, query: vi.fn().mockResolvedValue({ rows: [{ ...row, status: 'applied' }], rowCount: 1 }) }
    let release!: (snapshot: NativeMcpSnapshot) => void
    const background = new Promise<NativeMcpSnapshot>((resolve) => { release = resolve })
    finishBackground = () => release(snapshot)
    const read = vi.fn().mockResolvedValue(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockReturnValueOnce(background)
    const apply = vi.fn(async () => { read.mockResolvedValue(updated) })
    service = new HarnessMcpSettingsService(pool as never, {} as never, { codex: { read, apply } }, vi.fn())
    await service.list(principal, 'codex')
    await writeFile(file, '# external edit\n')
    const previousRead = service.list(principal, 'codex')
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
    expect(await service.decide(principal, row.id, true)).toMatchObject({ status: 'applied' })
    expect(apply).toHaveBeenCalledOnce()
    const after = await service.list(principal, 'codex')
    expect(after.servers.map(server => server.name)).toEqual(['added'])
    expect(read).toHaveBeenCalledTimes(4)
    release(snapshot)
    await previousRead
    expect(await service.list(principal, 'codex')).toEqual(after)
    expect(read).toHaveBeenCalledTimes(4)
    await expect(service.list({ ...principal, grants: [] }, 'codex')).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  } finally {
    finishBackground?.()
    await service?.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
