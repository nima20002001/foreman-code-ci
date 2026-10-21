import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HarnessCatalogEntrySchema, HarnessCatalogResultSchema, HarnessDefaultsUpdateResultSchema,
  HarnessOptionsResultSchema, ManagementHarnessDefaultsSchema } from '@foreman-code/contracts/management'
import { useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

const withRemoteReviewFixture = useRemoteReviewFixture({ modelCatalog: 'empty-at-startup', claudeInventory: true })

describe('production remote review and native recovery through authenticated MCP', () => {
  it('keeps unavailable native defaults until an explicit choice through authenticated HTTP and MCP', async () => {
    await withRemoteReviewFixture(async fixture => {
      const catalog = HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'codex' }))
      expect(catalog.capability).toBeNull()
      expect(catalog.discoveryError?.code).toBe('HARNESS_MODEL_DEFAULT_UNAVAILABLE')
      const initialOptions = HarnessOptionsResultSchema.parse(fixture.startupCatalog)
      expect(initialOptions.models).toEqual([])
      const options = HarnessOptionsResultSchema.parse(await fixture.value('harness_options_refresh', { harness: 'codex' }))
      expect(options.models.map(model => model.id)).toContain('test-model')
      expect(options.models.find(model => model.id === 'test-model')).toMatchObject({ defaultPriority: 0 })
      expect(HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'codex' }))).toEqual(catalog)
      const configuration = (await fixture.db.pool.query<{ record: { harness: { model: string } } }>(
        'select record from agent_configuration_versions where id=$1',
        [fixture.version.agentConfigurationVersionIds[fixture.version.approval.designatedOrchestratorAgentId!]])
      ).rows[0]!
      expect(configuration.record.harness.model).toBe('test-model')
      const response = await fetch(`${fixture.origin()}/api/management/harnesses/codex`, {
        headers: { authorization: `Bearer ${fixture.writer.token}` },
      })
      expect(response.status).toBe(200)
      expect(HarnessCatalogEntrySchema.parse(await response.json())).toEqual(catalog)
      const reader = await fixture.access.issue({ name: 'No harness grants', audience: 'operator',
        expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['settings:read'], scope: {} }] })
      const deniedHttp = await fetch(`${fixture.origin()}/api/management/harnesses/codex`, {
        headers: { authorization: `Bearer ${reader.token}` },
      })
      expect(deniedHttp.status).toBe(403)
      const denied = await fixture.call('harness_get', { harness: 'codex' }, reader.token)
        .then(result => ({ result }), (error: unknown) => ({ error }))
      if ('error' in denied) expect(denied.error).toMatchObject({ code: -32602 })
      else expect(denied.result.isError).toBe(true)
      const presets = HarnessCatalogResultSchema.parse(await fixture.value('harness_list', {}))
      const defaults = ManagementHarnessDefaultsSchema.parse(Object.fromEntries(
        presets.items.map(entry => [entry.harness, entry.defaults])))
      defaults.codex.model = 'test-model'
      const input = { commandId: randomUUID(), expectedRevision: catalog.defaultsRevision,
        defaults, configure: ['codex'] }
      const saved = HarnessDefaultsUpdateResultSchema.parse(await fixture.value('harness_defaults_update', input))
      expect(saved.value.defaults.codex.model).toBe('test-model')
      expect(HarnessDefaultsUpdateResultSchema.parse(await fixture.value('harness_defaults_update', input)))
        .toEqual({ ...saved, replayed: true })
      const selected = HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'codex' }))
      expect(selected.discoveryError).toBeNull()
      expect(selected.capability?.ready).toBe(true)
      // A Claude preset stays unavailable until its exact host profile is checked.
      const unconfigured = HarnessCatalogEntrySchema.parse(await fixture.value('harness_get', { harness: 'claude' }))
      expect(unconfigured.capability).toBeNull()
      expect(unconfigured.discoveryError?.code).toBe('CLAUDE_PROFILE_SELECTION_REQUIRED')
      const claudeResponse = await fetch(`${fixture.origin()}/api/management/harnesses/claude`, {
        headers: { authorization: `Bearer ${fixture.writer.token}` },
      })
      expect(claudeResponse.status).toBe(200)
      expect(HarnessCatalogEntrySchema.parse(await claudeResponse.json())).toEqual(unconfigured)
      const deniedSave = await fixture.call('harness_defaults_update', { ...input, commandId: randomUUID() }, reader.token)
        .then(result => ({ result }), (error: unknown) => ({ error }))
      if ('error' in deniedSave) expect(deniedSave.error).toMatchObject({ code: -32602 })
      else expect(deniedSave.result.isError).toBe(true)
    })
  }, 240_000)
})
