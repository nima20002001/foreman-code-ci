import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { DevicePairingGrantResultSchema, DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { pairingProof, publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { BuildComputerStatusSchema } from '@foreman-code/contracts/build-computers'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { BuildComputerSettings } from '../src/modules/settings/buildComputers.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.skipIf(!postgresEnabled)('paired computer build defaults', () => {
  it('sets defaults once and rebinds a re-paired target while preserving disabled settings and revisions through MCP', async () => {
    const db = await currentDatabase()
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const mainId = (await db.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
      const access = new PostgresAccessService(db.pool)
      const commands = new PostgresCommandCoordinator(db.pool)
      let devices = new PostgresDeviceAccessService(db.pool, mainId)
      const settings = new BuildComputerSettings(db.pool, commands,
        async () => ({ state: 'ready', reasons: [], remoteExecutionEnabled: true }))
      const services = { devices, commands, buildComputers: settings } as unknown as OperatorServices
      app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services } })
      const owner = await access.issue({ name: 'Pairing owner', audience: 'operator',
        grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }],
        expiresAt: new Date(Date.now() + 600_000) })
      const reader = await access.issue({ name: 'Pairing reader', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'Pairing build defaults', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => token } }))
        return client
      }
      const client = await connect(owner.token)
      const denied = await connect(reader.token)
      const keys = generateKeyPairSync('ed25519')
      const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const grantInput = { workerInstallationId: randomUUID(), publicKey,
        expectedFingerprint: publicKeyFingerprint(publicKey), scopes: ['connect', 'heartbeat'], commandId: randomUUID() }
      expect((await denied.callTool({ name: 'device_pairing_grant_create', arguments: grantInput })).isError).toBe(true)
      expect((await db.pool.query('select count(*)::int as count from build_computer_preferences')).rows[0]?.count).toBe(0)
      const granted = DevicePairingGrantResultSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'device_pairing_grant_create', arguments: grantInput,
      })))
      expect((await db.pool.query('select count(*)::int as count from build_computer_preferences')).rows[0]?.count).toBe(0)
      const pairing = { mainId, workerInstallationId: grantInput.workerInstallationId,
        publicKey, grant: granted.grant, requestId: randomUUID() }
      const request = { ...pairing,
        signature: sign(null, Buffer.from(pairingProof(pairing)), keys.privateKey).toString('base64url') }
      const paired = await devices.pair(request)
      const target = { hostRef: { kind: 'device' as const, mainId, deviceId: paired.registration.deviceId },
        applicationInstallationId: paired.registration.workerInstallationId, keyRevision: paired.registration.keyRevision,
        authorizationRevision: paired.registration.authorizationRevision }
      const read = async (selected = target) => BuildComputerStatusSchema.parse(decodeMcpToolResult(
        await client.callTool({ name: 'build_computer_get', arguments: { target: selected } })))
      const defaults = await read()
      expect(defaults.preference).toMatchObject({ target, revision: 1, buildEnabled: true,
        buildPriority: 50, buildAllowancePercent: 100 })
      expect(await devices.pair(request)).toEqual(paired)
      devices = new PostgresDeviceAccessService(db.pool, mainId)
      services.devices = devices
      expect(await devices.pair(request)).toEqual(paired)
      expect(await read()).toEqual(defaults)
      const disabled = await client.callTool({ name: 'build_computer_update', arguments: { target,
        commandId: randomUUID(), expectedRevision: 1, buildEnabled: false, buildPriority: 73, buildAllowancePercent: 40 } })
      expect(disabled.isError).not.toBe(true)
      const revoked = DeviceRegistrationSchema.parse(decodeMcpToolResult(await client.callTool({ name: 'device_revoke',
        arguments: { deviceId: paired.registration.deviceId, expectedRevision: 1, commandId: randomUUID() } })))
      const regranted = DevicePairingGrantResultSchema.parse(decodeMcpToolResult(await client.callTool({
        name: 'device_pairing_grant_create', arguments: { ...grantInput, commandId: randomUUID(),
          expectedAuthorizationRevision: revoked.authorizationRevision },
      })))
      const repair = { ...pairing, grant: regranted.grant, requestId: randomUUID() }
      const repaired = await devices.pair({ ...repair,
        signature: sign(null, Buffer.from(pairingProof(repair)), keys.privateKey).toString('base64url') })
      const repairedTarget = { ...target, keyRevision: repaired.registration.keyRevision,
        authorizationRevision: repaired.registration.authorizationRevision }
      const preserved = await read(repairedTarget)
      expect(preserved.preference).toMatchObject({ target: repairedTarget, revision: 3, buildEnabled: false,
        buildPriority: 73, buildAllowancePercent: 40 })
      expect((await client.callTool({ name: 'build_computer_update', arguments: { target: repairedTarget,
        commandId: randomUUID(), expectedRevision: 2, buildEnabled: true, buildPriority: 50 } })).isError).toBe(true)
      expect(await read(repairedTarget)).toEqual(preserved)
      expect((await db.pool.query("select count(*)::int as count from management_audit where action='device_pair' and outcome='succeeded'")).rows[0]?.count).toBe(2)
      expect((await db.pool.query('select count(*)::int as count from build_computer_preferences')).rows[0]?.count).toBe(1)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await db.close()
    }
  }, 120_000)
})
