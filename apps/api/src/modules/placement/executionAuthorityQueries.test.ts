import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { authorityQueryFixture } from './executionAuthorityQueries.testSupport.js'

describe('execution authorization database work', () => {
  it('authorizes with the real permission, source, root, device and harness services using bounded queries', async () => {
    const f = authorityQueryFixture()
    await expect(f.request()).resolves.toEqual({ payload: { version: 1, action: 'read',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId, bindingHash: f.intent.bindingHash,
      owner: f.intent.owner } })
    expect(f.counts().leases).toBe(1)
    expect(f.counts().queries).toBeLessThanOrEqual(10)
  })

  it.each([
    ['owner', 'RUN_AUTHORIZATION_REVOKED'], ['owner-expiry', 'AUTH_REVOKED'],
    ['principal', 'RUN_AUTHORIZATION_REVOKED'], ['binding-owner', 'RUN_AUTHORIZATION_REVOKED'],
    ['delegation-cycle', 'RUN_AUTHORIZATION_REVOKED'],
    ['ceiling', 'RUN_AUTHORIZATION_REVOKED'], ['workspace-scope', 'RUN_AUTHORIZATION_REVOKED'],
    ['workflow-scope', 'RUN_AUTHORIZATION_REVOKED'], ['source-grant', 'ACCESS_DENIED'],
    ['root-grant', 'ACCESS_DENIED'], ['location-grant', 'RUN_AUTHORIZATION_REVOKED'],
    ['device', 'revoked'], ['device-key', 'REMOTE_AUTHORITY_DENIED'],
    ['device-authorization', 'REMOTE_AUTHORITY_DENIED'], ['installation', 'wrong_main'],
    ['source', 'SOURCE_UNAVAILABLE'], ['source-binding', 'PLACEMENT_ADMISSION_CONFLICT'],
    ['root-policy', 'ROOT_POLICY_UNAVAILABLE'], ['root-configuration', 'ROOT_POLICY_CONFLICT'],
    ['root-registration', 'ROOT_POLICY_CONFLICT'], ['archived-workspace', 'WORKSPACE_ARCHIVED'],
    ['harness', 'HARNESS_PROFILE_UNAVAILABLE'], ['owner-grant', 'REMOTE_AUTHORITY_DENIED'],
    ['origin', 'REMOTE_AUTHORITY_DENIED'], ['receipt-owner', 'REMOTE_AUTHORITY_DENIED'],
  ])('denies revoked or changed %s authority', async (defect, code) => {
    const f = authorityQueryFixture()
    const s = f.state
    if (defect === 'owner') s.owner.revoked_at = new Date()
    if (defect === 'owner-expiry') s.owner.expires_at = new Date('2000-01-01T00:00:00.000Z')
    if (defect === 'principal') s.principal.expires_at = new Date('2000-01-01T00:00:00.000Z')
    if (defect === 'binding-owner') s.binding.owner_principal_id = 'other'
    if (defect === 'delegation-cycle') Object.assign(s.owner, { delegated_from: s.principal.id })
    if (defect === 'ceiling') s.binding.grant_ceiling = []
    if (defect === 'workspace-scope') s.owner.grants = [{ actions: ['runs:start'], scope: { workspaceIds: ['other'] } }]
    if (defect === 'workflow-scope') s.owner.grants = [{ actions: ['runs:start'], scope: { workflowIds: ['other'] } }]
    if (defect === 'source-grant') s.owner.grants = [s.owner.grants[0]!,
      { ...s.owner.grants[1]!, actions: ['workspace_locations:read', 'source_roots:read'] }]
    if (defect === 'root-grant') s.owner.grants = [s.owner.grants[0]!,
      { ...s.owner.grants[1]!, actions: ['workspace_locations:read', 'sources:read'] }]
    if (defect === 'location-grant') s.owner.grants = [s.owner.grants[0]!,
      { ...s.owner.grants[1]!, actions: ['sources:read', 'source_roots:read'] }]
    if (defect === 'device') s.device.status = 'revoked'
    if (defect === 'device-key') s.device.keyRevision++
    if (defect === 'device-authorization') s.device.authorizationRevision++
    if (defect === 'installation') s.mainId = randomUUID()
    if (defect === 'source') s.availability = 'unavailable'
    if (defect === 'source-binding') s.root = { ...s.root, attestationDigest: 'b'.repeat(64) }
    if (defect === 'root-policy') s.policyRevokedAt = new Date()
    if (defect === 'root-configuration') s.configuration.configurationRevision = '2'
    if (defect === 'root-registration') s.policy = { ...s.policy, registration: { ...s.policy.registration!, keyRevision: 2 } }
    if (defect === 'archived-workspace') s.workspaceArchivedAt = new Date()
    if (defect === 'harness') s.proof.qualified = false
    if (defect === 'owner-grant') s.granted = false
    if (defect === 'origin') s.origin = { ...s.origin, workerInstallationId: randomUUID() }
    if (defect === 'receipt-owner') s.receipt!.intent = { ...f.intent, owner: { grantId: 'other', epoch: '2' } }
    await expect(f.request()).rejects.toMatchObject({ code })
  })

  it.each([['owner', 'RUN_AUTHORIZATION_REVOKED'], ['device', 'revoked'], ['source', 'SOURCE_UNAVAILABLE'],
    ['root-policy', 'ROOT_POLICY_UNAVAILABLE'], ['owner-grant', 'REMOTE_AUTHORITY_DENIED']])(
    'rechecks %s revocation at commit', async (revoked, code) => {
      const f = authorityQueryFixture()
      f.state.afterPins = () => {
        if (revoked === 'owner') f.state.owner.revoked_at = new Date()
        if (revoked === 'device') f.state.device.status = 'revoked'
        if (revoked === 'source') f.state.availability = 'unavailable'
        if (revoked === 'root-policy') f.state.policyRevokedAt = new Date()
        if (revoked === 'owner-grant') f.state.granted = false
      }
      await expect(f.request()).rejects.toMatchObject({ code })
    })

  it('reads fresh authority on the next request without a revocation cache', async () => {
    const f = authorityQueryFixture()
    await expect(f.request()).resolves.toHaveProperty('payload')
    f.state.device.status = 'revoked'
    await expect(f.request()).rejects.toMatchObject({ code: 'revoked' })
    await expect(f.assertDevice()).rejects.toMatchObject({ code: 'revoked' })
  })

  it.each(['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const)(
    'rejects an authenticated %s that differs from the placement', async field => {
      const f = authorityQueryFixture()
      const authenticated = { ...f.connection }
      if (field === 'keyRevision' || field === 'authorizationRevision') authenticated[field]++
      else authenticated[field] = randomUUID()
      await expect(f.request('read', authenticated)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    })

  it('allows a root principal without a delegated Run binding', async () => {
    const f = authorityQueryFixture()
    f.state.principal.delegated_from = null
    await expect(f.request()).resolves.toHaveProperty('payload')
  })

  it('preserves cleanup reads and stops while enforcing device and owner grants', async () => {
    const f = authorityQueryFixture()
    f.state.cleanup = true
    f.state.owner.revoked_at = new Date()
    f.state.availability = 'unavailable'
    f.state.policyRevokedAt = new Date()
    f.state.proof.qualified = false
    for (const action of ['read', 'stop'] as const) {
      await expect(f.request(action)).resolves.toMatchObject({ payload: { action, cleanupOnly: true } })
    }
    await expect(f.request('control')).rejects.toMatchObject({ code: 'RUN_AUTHORIZATION_REVOKED' })
    f.state.granted = false
    await expect(f.request('stop')).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.granted = true
    f.state.device.status = 'revoked'
    await expect(f.request('read')).rejects.toMatchObject({ code: 'revoked' })
  })

  it('preserves same-boot reconnection and narrows a restarted boot to reads', async () => {
    const f = authorityQueryFixture()
    await expect(f.request('control', { ...f.connection, connectionGeneration: 2 })).resolves.toHaveProperty('payload')
    const restarted = { ...f.connection, bootId: randomUUID() }
    f.state.availability = 'unavailable'
    await expect(f.request('read', restarted)).resolves.toHaveProperty('payload')
    await expect(f.request('control', restarted)).rejects.toMatchObject({ code: 'REMOTE_AUTHORITY_DENIED' })
    f.state.owner.revoked_at = new Date()
    await expect(f.request('read', restarted)).rejects.toMatchObject({ code: 'RUN_AUTHORIZATION_REVOKED' })
  })
})
