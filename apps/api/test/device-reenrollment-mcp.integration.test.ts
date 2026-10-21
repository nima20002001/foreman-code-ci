import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it } from 'vitest'
import { DeviceSetupApproveResultSchema } from '@foreman-code/contracts/device-setup'
import { workerIdentityRequestCode } from '@foreman-code/contracts/device-setup-node'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { DeviceListResultSchema, DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { loadOrCreateMainDeviceIdentity } from '../src/modules/devices/mainIdentity.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

it('re-enrolls a revoked computer through authenticated MCP with live revision checks and persisted readback', async () => {
  const db = await currentDatabase()
  const access = new PostgresAccessService(db.pool)
  const commands = new PostgresCommandCoordinator(db.pool)
  const mainId = (await db.pool.query('select id from application_installation where singleton=true')).rows[0]!.id
  await loadOrCreateMainDeviceIdentity(db.pool, mainId)
  const workerKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const registration = DeviceRegistrationSchema.parse({ mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    publicKeyFingerprint: publicKeyFingerprint(workerKey), keyRevision: 1, authorizationRevision: 1,
    status: 'paired', scopes: ['connect', 'heartbeat'] })
  await db.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
    values($1,$2,$3,$4,$5)`, [registration.deviceId, mainId, registration.workerInstallationId, workerKey, registration])
  const endpoint = 'wss://192.0.2.10:8443/device/connect'
  const devices = new PostgresDeviceAccessService(db.pool, mainId, undefined,
    () => ({ available: true, endpoint, reason: null }))
  const owner = await access.issue({ name: 'Owner', audience: 'operator',
    grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }], expiresAt: new Date(Date.now() + 600000) })
  const reader = await access.issue({ name: 'Reader', audience: 'operator',
    grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600000) })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { commands, devices } as unknown as OperatorServices } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'reenrollment-test', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(owner.token)
    const readOnly = await connect(reader.token)
    const stored = async () => (await db.pool.query('select record from device_registrations where id=$1',
      [registration.deviceId])).rows.map(row => row.record)
    const revoked = DeviceRegistrationSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'device_revoke', arguments: { deviceId: registration.deviceId,
        expectedRevision: registration.authorizationRevision, commandId: randomUUID() },
    })))
    expect(revoked).toEqual({ ...registration, status: 'revoked', authorizationRevision: 2 })
    expect(await stored()).toEqual([revoked])
    const input = { commandId: randomUUID(), endpoint,
      identityRequestCode: workerIdentityRequestCode({ workerInstallationId: registration.workerInstallationId,
        publicKey: workerKey, publicKeyFingerprint: registration.publicKeyFingerprint }),
      scopes: registration.scopes, expectedAuthorizationRevision: revoked.authorizationRevision }
    const denied = await readOnly.callTool({ name: 'device_setup_code_create', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await stored()).toEqual([revoked])
    expect((await db.pool.query(`select source,action,outcome from management_audit
      where principal_id=$1`, [reader.principal.id])).rows)
      .toEqual([{ source: 'mcp', action: 'device_setup_code_create', outcome: 'denied' }])
    const stale = await client.callTool({ name: 'device_setup_code_create', arguments: {
      ...input, commandId: randomUUID(), expectedAuthorizationRevision: revoked.authorizationRevision - 1,
    } })
    expect(stale.isError).toBe(true)
    expect(decodeMcpToolResult(stale)).toMatchObject({ error: { code: 'conflict' } })
    expect(await stored()).toEqual([revoked])
    expect((await db.pool.query('select device_id from device_pairing_grants')).rows).toEqual([])
    const issued = DeviceSetupApproveResultSchema.parse(decodeMcpToolResult(await client.callTool({
      name: 'device_setup_code_create', arguments: input,
    })))
    expect(issued.registration).toEqual({ ...revoked, status: 'pending', authorizationRevision: 3 })
    expect(await stored()).toEqual([issued.registration])
    const persisted = DeviceListResultSchema.parse(decodeMcpToolResult(await readOnly.callTool({
      name: 'devices_list', arguments: {},
    })))
    expect(persisted.devices).toEqual([issued.registration])
    expect(JSON.stringify(persisted)).not.toContain(issued.enrollmentCode)
    expect(decodeMcpToolResult(await client.callTool({ name: 'device_setup_code_create', arguments: input })))
      .toEqual(issued)
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await db.close()
  }
})
