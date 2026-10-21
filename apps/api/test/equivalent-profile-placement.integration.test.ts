import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { resolveBoundRootPlacement } from '../src/modules/placement/localMainPlacement.js'
import { DomainError } from '../src/modules/errors.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { fixture, startInput, toolError } from './helpers/nodePlacementStartFixture.js'

afterEach(() => vi.restoreAllMocks())

type Fixture = Awaited<ReturnType<typeof fixture>>

async function profilesFor(f: Fixture, host: 'main' | 'device') {
  const placement = host === 'main' ? f.placement.local : f.placement.remote
  const row = (await f.base.db.pool.query('select record from harness_instance_settings where instance_id=$1',
    [placement.instanceId])).rows[0]!
  const original = HostHarnessOverrideSchema.parse(row.record)
  const duplicate = { ...original, instanceId: '00000000-0000-4000-8000-000000000001' }
  await f.base.db.pool.query(`insert into harness_instance_settings(instance_id,revision,host_key,
    application_installation_id,record,configuration_fingerprint,created_by)
    select $2,revision,host_key,application_installation_id,$3::jsonb,configuration_fingerprint,created_by
    from harness_instance_settings where instance_id=$1`,
  [original.instanceId, duplicate.instanceId, JSON.stringify(duplicate)])
  await f.base.db.pool.query(`insert into harness_instance_profile_evidence(check_id,instance_id,instance_revision,record)
    select $2,$3,instance_revision,record from harness_instance_profile_evidence where instance_id=$1`,
  [original.instanceId, randomUUID(), duplicate.instanceId])
  const rootRow = (await f.base.db.pool.query('select record from source_root_bindings where root_id=$1',
    [placement.rootBinding!.rootId])).rows[0]!
  const root = SourceRootRecordSchema.parse(rootRow.record)
  const configuration = structuredClone(f.base.f.configurations[host === 'main' ? 0 : 1]!)
  expect(configuration).not.toHaveProperty('harnessProfileSelection')
  const resolve = () => resolveBoundRootPlacement({ sql: f.base.db.pool, principal: f.base.writer.principal,
    mainId: placement.hostRef.mainId, workspaceId: configuration.workspaceId, configuration, root,
    roots: f.placement.policies, installations: f.placement.installations,
    qualificationSuites: { codex: 'codex-live-4' } })
  return { original, duplicate, configuration, resolve }
}

describe.skipIf(!postgresEnabled)('equivalent qualified harness profile placement', () => {
  it.each(['main', 'device'] as const)('selects the lowest instance ID among identical qualified %s profiles', async host => {
    const f = await fixture()
    try {
      const p = await profilesFor(f, host)
      const expected = [p.original.instanceId, p.duplicate.instanceId].sort()[0]
      expect(await p.resolve()).toMatchObject({ instanceId: expected, instanceRevision: '1' })
      expect(await p.resolve()).toMatchObject({ instanceId: expected })
      p.configuration.harnessProfileSelection = { instanceId: p.original.instanceId,
        instanceRevision: p.original.instanceRevision, target: p.original.target }
      expect(await p.resolve()).toMatchObject({ instanceId: p.original.instanceId })
    } finally { await f.close() }
  }, 120_000)

  it.each(['disabled', 'unqualified'] as const)('ignores a lower instance ID that is %s', async state => {
    const f = await fixture()
    try {
      const p = await profilesFor(f, 'main')
      if (state === 'disabled') {
        p.duplicate.enabled = false
        await f.base.db.pool.query('update harness_instance_settings set record=$2::jsonb where instance_id=$1',
          [p.duplicate.instanceId, JSON.stringify(p.duplicate)])
      } else {
        await f.base.db.pool.query('delete from harness_instance_profile_evidence where instance_id=$1',
          [p.duplicate.instanceId])
      }
      expect(await p.resolve()).toMatchObject({ instanceId: p.original.instanceId })
    } finally { await f.close() }
  }, 120_000)

  it('reports the Agent, node and required configuration through MCP when only writable profiles exist', async () => {
    const f = await fixture()
    try {
      const saved = await f.save('mcp')
      const p = await profilesFor(f, 'main')
      expect(p.configuration.harness).toMatchObject({ harness: 'codex', sandbox: 'read-only' })
      for (const profile of [p.original, p.duplicate]) {
        if (profile.configuration.harness !== 'codex') throw new Error('Expected a Codex profile.')
        profile.configuration = { ...profile.configuration, sandbox: 'workspace-write' }
        await f.base.db.pool.query('update harness_instance_settings set record=$2::jsonb where instance_id=$1',
          [profile.instanceId, JSON.stringify(profile)])
      }
      const result = toolError(await f.client.callTool({ name: 'run_start', arguments: startInput(f, saved) }))
      expect(result).toMatchObject({ error: { code: 'PLACEMENT_ADMISSION_CONFLICT', details: {
        reason: 'selected_harness_profile', agentId: p.configuration.agentId,
        nodeId: saved.version.definition.nodes[0]!.id,
      } } })
      if (p.configuration.harness.harness !== 'codex') throw new Error('Expected a Codex configuration.')
      expect(result.error.details.requiredConfiguration).toEqual({ harness: 'codex',
        model: p.configuration.harness.model, reasoningEffort: p.configuration.harness.reasoningEffort,
        sandbox: 'read-only' })
      expect(result.error.message).toContain(p.configuration.agentId)
      expect(result.error.message).toContain(saved.version.definition.nodes[0]!.id)
      expect(result.error.message).toContain('read-only')
      expect((await f.base.db.pool.query('select id from runs where workflow_id=$1',
        [f.saveInput.workflowId])).rows).toEqual([])
    } finally { await f.close() }
  }, 120_000)

  it.each([
    { host: 'main', harness: 'codex' },
    { host: 'device', harness: 'codex' },
    { host: 'main', harness: 'claude' },
    { host: 'device', harness: 'claude' },
  ] as const)('omits private $harness configuration from $host placement errors', async ({ host, harness }) => {
    const f = await fixture()
    try {
      const p = await profilesFor(f, host)
      const privateInstruction = 'private-instruction-fixture'
      const privateCredential = 'private-credential-fixture'
      const privateServer = 'private-mcp-fixture'
      let requiredConfiguration
      if (harness === 'codex') {
        p.configuration.harness = { harness, model: 'diagnostic-model', reasoningEffort: 'medium',
          sandbox: 'read-only', serviceTier: 'standard', advanced: {
            ...DEFAULT_CODEX_ADVANCED_CONFIGURATION,
            shellEnvironment: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION.shellEnvironment,
              set: { FIXTURE_CREDENTIAL: privateCredential } },
            mcpServers: { [privateServer]: { enabled: true, required: false } },
          } }
        requiredConfiguration = { harness, model: 'diagnostic-model', reasoningEffort: 'medium', sandbox: 'read-only' }
      } else {
        p.configuration.harness = { harness, model: 'diagnostic-model', effort: 'high', sandbox: 'danger-full-access',
          authMode: 'api-key', configDirectory: '/private/configuration', permissionMode: 'default',
          tools: ['Read'], permissionRules: [], instructions: `${privateInstruction} ${privateCredential}`,
          mcpServers: { [privateServer]: { type: 'http', url: 'https://mcp.example.invalid/private-fixture' } } }
        requiredConfiguration = { harness, model: 'diagnostic-model', effort: 'high', sandbox: 'danger-full-access' }
      }
      const error: unknown = await p.resolve().catch((error: unknown) => error)
      expect(error).toBeInstanceOf(DomainError)
      if (!(error instanceof DomainError)) throw error
      expect(error.details?.requiredConfiguration).toEqual(requiredConfiguration)
      expect(error.message).toContain(JSON.stringify(requiredConfiguration))
      const response = JSON.stringify({ message: error.message, details: error.details })
      for (const value of [privateInstruction, privateCredential, privateServer, 'instructions', 'mcpServers',
        'shellEnvironment', 'configDirectory', '/private/configuration', 'https://mcp.example.invalid/private-fixture']) {
        expect(response).not.toContain(value)
      }
    } finally { await f.close() }
  }, 120_000)
})
