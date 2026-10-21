import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagementActionSchema, ManagedAgentDefaultsSchema, ManagedWorkflowDefaultsSchema,
  ManagedWorkspaceDefaultsSchema } from '@foreman-code/contracts/management'
import { deferred } from './helpers/deferred.js'
import { withClientTransaction } from '../src/infrastructure/transaction.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
async function command(f: Fixture, kind: string) {
  const commandId = randomUUID()
  if (kind.endsWith('defaults')) {
    const role = kind.split('-')[0]!
    const name = `${role}_defaults_get`
    const original = decodeMcpToolResult(await f.client.callTool({ name, arguments: {} }))
    const schemas = { agent: ManagedAgentDefaultsSchema, workflow: ManagedWorkflowDefaultsSchema,
      workspace: ManagedWorkspaceDefaultsSchema }
    const schema = schemas[role as keyof typeof schemas]
    const value = schema.parse(original)
    return { name: `${role}_defaults_update`, operation: `${role}.defaults.update`,
      input: { commandId, expectedRevision: value.revision, value: value.value },
      read: async () => decodeMcpToolResult(await f.client.callTool({ name, arguments: {} })) }
  }
  const workspaceId = f.f.scope.workspaceId
  const config = f.f.configurations[1]!
  const sourceAgentId = config.agentId
  const read = async () => decodeMcpToolResult(await f.client.callTool({ name: 'agent_get',
    arguments: { workspaceId, agentId: sourceAgentId } }))
  const existing = await read() as { agent: { configurationVersionId: string }; metadataRevision: number }
  const base = { commandId, workspaceId, agentId: sourceAgentId,
    expectedRevision: existing.metadataRevision, expectedConfigurationVersionId: existing.agent.configurationVersionId }
  if (kind === 'update') return { name: 'agent_update', operation: 'agent.update', input: { ...base, name: 'Edited Agent' }, read }
  if (kind === 'restore') return { name: 'agent_configuration_restore', operation: 'agent.configuration.restore',
    input: { ...base, versionId: existing.agent.configurationVersionId }, read }
  const agentId = randomUUID()
  if (kind === 'clone') return { name: 'agent_clone', operation: 'agent.clone',
    input: { commandId, workspaceId, agentId, sourceAgentId, name: 'Cloned Agent',
      expectedSourceRevision: existing.metadataRevision,
      expectedSourceConfigurationVersionId: existing.agent.configurationVersionId }, read }
  return { name: 'agent_create', operation: 'agent.create',
    input: { commandId, workspaceId, agentId, name: 'Created Agent', productRole: 'coder', configuration: config.harness }, read }
}

it.each(['workspace-defaults', 'agent-defaults', 'workflow-defaults', 'create', 'update', 'clone', 'restore'])(
  'denies a queued %s command after parent revocation', async kind => {
    const f = await currentOperatorIntegration({ agentManagement: true, insertRun: false })
    const blocker = await f.db.pool.connect()
    let lock: string | undefined
    const releaseAuthority = deferred()
    let authorityBlocker: Promise<void> | undefined
    try {
      const parent = await f.access.issue({ name: 'Delegating owner', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      const caller = await f.access.issue({ name: 'Queued writer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
      await f.db.pool.query('update management_principals set delegated_from=$2 where id=$1', [caller.principal.id, parent.principal.id])
      const client = await f.connect(caller.token)
      const c = await command(f, kind)
      const before = await c.read()
      let blockerPid: number | undefined
      if (kind === 'agent-defaults') {
        const entered = deferred()
        blockerPid = (await blocker.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        authorityBlocker = withClientTransaction(blocker, async () => {
          // Authentication reads normally; the command's live authority read takes a row lock.
          await blocker.query('select id from management_principals where id=$1 for update', [caller.principal.id])
          entered.resolve()
          await releaseAuthority.promise
        })
        await Promise.race([entered.promise, authorityBlocker])
      } else {
        lock = kind.endsWith('defaults') ? `command:${caller.principal.id}:${c.operation}:${c.input.commandId}`
          : `admission:workspace:${f.f.scope.workspaceId}`
        await blocker.query('select pg_advisory_lock(hashtext($1))', [lock])
      }
      const request = client.callTool({ name: c.name, arguments: c.input })
      await vi.waitFor(async () => {
        const commandLock = `command:${caller.principal.id}:${c.operation}:${c.input.commandId}`
        let waiting: { rowCount: number | null }
        if (kind === 'agent-defaults') {
          waiting = await f.db.pool.query(`select 1 from pg_stat_activity activity
            where $1::int=any(pg_blocking_pids(activity.pid)) and exists (
              select 1 from pg_locks owned where owned.pid=activity.pid and owned.locktype='advisory'
                and owned.objid=(hashtext($2)::bigint & 4294967295)::oid and owned.granted)`,
          [blockerPid, commandLock])
        } else {
          // Preparation releases the command lock before waiting for the workspace lock.
          waiting = await f.db.pool.query(`select 1 from pg_locks where locktype='advisory'
            and objid=(hashtext($1)::bigint & 4294967295)::oid and not granted`, [lock])
        }
        expect(waiting.rowCount).toBeGreaterThan(0)
      }, { timeout: 3_000, interval: 10 })
      await f.access.revoke(parent.principal.id)
      releaseAuthority.resolve()
      await authorityBlocker
      if (lock) await blocker.query('select pg_advisory_unlock(hashtext($1))', [lock])
      lock = undefined
      const result = await request
      expect(result.isError).toBe(true)
      if (kind === 'agent-defaults') {
        expect(decodeMcpToolResult(result)).toMatchObject({ error: { code: 'AUTH_REVOKED' } })
      }
      expect(await c.read()).toEqual(before)
      expect((await f.db.pool.query('select 1 from management_command_receipts where principal_id=$1 and command_id=$2',
        [caller.principal.id, c.input.commandId])).rows).toHaveLength(0)
    } finally {
      releaseAuthority.resolve()
      await authorityBlocker
      if (lock) await blocker.query('select pg_advisory_unlock(hashtext($1))', [lock])
      blocker.release()
      await f.close()
    }
  }, 60_000,
)

it.each(['http', 'mcp'] as const)('denies an expired queued defaults receipt through %s', async transport => {
  const f = await currentOperatorIntegration({ insertRun: false })
  const blocker = await f.db.pool.connect()
  let lock: string | undefined
  try {
    const caller = await f.access.issue({ name: 'Expiring writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
    const client = await f.connect(caller.token)
    const c = await command(f, 'workflow-defaults')
    expect((await client.callTool({ name: c.name, arguments: c.input })).isError).not.toBe(true)
    const before = await c.read()
    lock = `command:${caller.principal.id}:${c.operation}:${c.input.commandId}`
    await blocker.query('select pg_advisory_lock(hashtext($1))', [lock])
    const request = transport === 'mcp' ? client.callTool({ name: c.name, arguments: c.input })
      : f.app.inject({ method: 'PUT', url: '/api/management/settings/workflows',
        headers: { authorization: `Bearer ${caller.token}` }, payload: c.input }).then(response => response)
    await vi.waitFor(async () => {
      expect((await f.db.pool.query(`select 1 from pg_locks where locktype='advisory'
        and objid=(hashtext($1)::bigint & 4294967295)::oid and not granted`, [lock])).rowCount).toBeGreaterThan(0)
    }, { timeout: 3_000, interval: 10 })
    await f.db.pool.query("update management_principals set expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [caller.principal.id])
    await blocker.query('select pg_advisory_unlock(hashtext($1))', [lock])
    lock = undefined
    const result = await request
    if ('statusCode' in result) expect(result.statusCode).toBe(403)
    else expect(result.isError).toBe(true)
    expect(await c.read()).toEqual(before)
    expect((await f.db.pool.query('select 1 from management_command_receipts where principal_id=$1 and command_id=$2',
      [caller.principal.id, c.input.commandId])).rows).toHaveLength(1)
  } finally {
    if (lock) await blocker.query('select pg_advisory_unlock(hashtext($1))', [lock])
    blocker.release()
    await f.close()
  }
}, 60_000)
