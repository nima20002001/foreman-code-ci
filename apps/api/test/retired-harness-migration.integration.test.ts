import { randomBytes, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { retiredHarnessCredentialsMigration } from '../src/infrastructure/retiredHarnessCredentialsMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresFileConversationAuthorization } from '../src/modules/files/authorization.js'
import { bindingIdentity, digest, FileToolSessions } from '../src/modules/files/tools/context.js'
import { PostgresFileToolRepository } from '../src/modules/files/tools/postgres.js'
import type { FileToolContext } from '../src/modules/files/tools/types.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

const retiredConfiguration = {
  harness: 'opencode', model: 'saved-provider/model', variant: 'max', nativeAgent: 'build',
  thinking: true, autoApprove: false,
}
const replacementConfiguration = {
  harness: 'codex' as const, model: 'gpt-5.6-luna', reasoningEffort: 'medium' as const,
  sandbox: 'read-only' as const, serviceTier: 'standard' as const,
}

it.skipIf(!postgresEnabled)(
  'retires historical defaults and file credentials without changing saved configurations, workflows, or Runs',
  async () => {
    const database = await currentDatabase({ deferMigration: retiredHarnessCredentialsMigration.version })
    try {
      const appliedBefore = await database.pool.query<{ version: number }>('select version from application_migrations')
      expect(appliedBefore.rows.map(row => row.version).sort((a, b) => a - b))
        .toEqual(migrations.filter(migration => migration.version !== retiredHarnessCredentialsMigration.version)
          .map(migration => migration.version).sort((a, b) => a - b))
      const fixture = await seedAgent3(database.pool, database.directory)
      const operators = new PostgresOperatorRepository(database.pool)
      const operator = await operators.ensure()
      const access = new PostgresAccessService(database.pool)
      const owner = await access.issue({ name: 'Retirement migration owner', audience: 'operator',
        grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
        expiresAt: new Date(Date.now() + 600_000) })
      const conversation = await new PostgresOperatorConversationRepository(database.pool)
        .create(operator.operator.id, operator.configuration, owner.principal.id)
      const authorization = new PostgresFileConversationAuthorization(database.pool)
      const scope = await authorization.resolve(owner.principal,
        { kind: 'operator', conversationId: conversation.id }, 'read')
      const context: FileToolContext = { ownerPrincipalId: owner.principal.id, scope,
        nativeSessionId: randomUUID(), turnId: randomUUID(), allowMutation: false, allowedTools: ['files.read'] }
      const credentials = new PostgresFileToolRepository(database.pool)
      const sessions = new FileToolSessions(credentials, id => access.currentOperator(id), authorization)
      const expiresAt = new Date(Date.now() + 300_000).toISOString()
      const liveToken = `gql_file_${randomBytes(32).toString('base64url')}`
      const revokedToken = `gql_file_${randomBytes(32).toString('base64url')}`
      const revokedAt = '2026-10-01T00:00:00.000Z'
      const retiredSession = { context, expiresAt, transport: 'opencode', binding: bindingIdentity(context) }
      await database.pool.query(`insert into file_tool_sessions(token_hash,record,expires_at,revoked_at)
        values($1,$3::jsonb,$4,null),($2,$3::jsonb,$4,$5)`,
      [digest(liveToken), digest(revokedToken), JSON.stringify(retiredSession), expiresAt, revokedAt])
      const supportedToken = await sessions.issueForAcceptedSession(context, new Date(expiresAt))
      expect((await sessions.authenticate(liveToken)).context).toEqual(context)

      const configuration = fixture.configurations[0]!
      const historicalAgent = { ...configuration, harness: retiredConfiguration }
      const historicalOperator = { ...operator.configuration, harness: retiredConfiguration }
      await database.pool.query('update agent_configuration_versions set record=$2::jsonb where id=$1',
        [configuration.id, JSON.stringify(historicalAgent)])
      await database.pool.query('update operator_configuration_versions set record=$2::jsonb where id=$1',
        [operator.configuration.id, JSON.stringify(historicalOperator)])
      const savedFacts = async () => (await database.pool.query<{
        agent: unknown; operator: unknown; workflow: unknown; run: unknown; conversation: unknown
      }>(`select a.record as agent,o.record as operator,w.record as workflow,r.record as run,c.record as conversation
        from agent_configuration_versions a,operator_configuration_versions o,workflow_versions w,
          runs r,operator_conversations c
        where a.id=$1 and o.id=$2 and w.id=$3 and r.id=$4 and c.id=$5`,
      [configuration.id, operator.configuration.id, fixture.version.id, fixture.run.id, conversation.id])).rows[0]!
      const historicalFacts = await savedFacts()
      expect(historicalFacts.agent).toEqual(historicalAgent)
      expect(historicalFacts.operator).toEqual(historicalOperator)

      const selector = { instanceId: randomUUID(), instanceRevision: 'saved-profile', target: {
        hostRef: { kind: 'main', mainId: randomUUID() }, applicationInstallationId: randomUUID(),
        harnessInstallationId: 'saved-installation', installationFingerprint: 'saved-fingerprint',
      } }
      const historicalRoleDefaults = {
        orchestrator: { ...DEFAULT_AGENT_DEFAULTS.orchestrator, harness: retiredConfiguration,
          harnessProfileSelection: selector },
        coder: { ...DEFAULT_AGENT_DEFAULTS.coder, harness: retiredConfiguration, harnessProfileSelection: selector },
        operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: retiredConfiguration, harnessProfileSelection: selector },
      }
      const historicalHarnessDefaults = { codex: DEFAULT_HARNESS_DEFAULTS.codex, opencode: retiredConfiguration }
      const historicalVersionId = randomUUID()
      await database.pool.query(`insert into application_setting_versions(id,setting_key,version,record)
        values($1,'agent-defaults-v1',17,$2::jsonb)`,
      [historicalVersionId, JSON.stringify(historicalRoleDefaults)])
      await database.pool.query(`insert into application_settings(key,record,revision,current_version_id)
        values('harness-defaults',$1::jsonb,17,null),
          ('harness-default-model-unavailable','["codex","opencode"]'::jsonb,17,null),
          ('agent-defaults-v1',$2::jsonb,17,$3)
        on conflict(key) do update set record=excluded.record,revision=excluded.revision,
          current_version_id=excluded.current_version_id`,
      [JSON.stringify(historicalHarnessDefaults), JSON.stringify(historicalRoleDefaults), historicalVersionId])
      const settingKeys = ['harness-defaults', 'harness-default-model-unavailable', 'agent-defaults-v1',
        'retired-harness-defaults', 'retired-harness-unavailable']
      const storedSettings = async () => (await database.pool.query<{
        key: string; record: unknown; revision: number; current_version_id: string | null
      }>(`select key,record,revision::int,current_version_id from application_settings
        where key=any($1::text[]) order by key`, [settingKeys])).rows
      const storedVersions = async () => (await database.pool.query<{
        id: string; version: number; record: unknown
      }>(`select id,version,record from application_setting_versions
        where setting_key='agent-defaults-v1' and version>=17 order by version`)).rows
      const storedCredentials = async () => (await database.pool.query<{
        token_hash: string; record: unknown; revoked_at: string | null
      }>(`select token_hash,record,revoked_at::text from file_tool_sessions
        where token_hash=any($1::text[]) order by token_hash`,
      [[digest(liveToken), digest(revokedToken), digest(supportedToken)]])).rows
      const audits = async () => (await database.pool.query<{
        principal_id: string | null; source: string; action: string; outcome: string; details: unknown
      }>(`select principal_id,source,action,outcome,details from management_audit
        where action='harness.defaults.retire' and target_key='agent-defaults-v1' order by sequence`)).rows

      await applyApplicationMigrations(database.pool)

      expect(await savedFacts()).toEqual(historicalFacts)
      const settings = await storedSettings()
      expect(settings).toContainEqual({ key: 'harness-defaults', record: historicalHarnessDefaults,
        revision: 17, current_version_id: null })
      expect(settings).toContainEqual({ key: 'retired-harness-defaults', record: { opencode: retiredConfiguration },
        revision: 17, current_version_id: null })
      expect(settings).toContainEqual({ key: 'retired-harness-unavailable', record: ['codex', 'opencode'],
        revision: 17, current_version_id: null })
      expect(settings).toContainEqual({ key: 'harness-default-model-unavailable', record: ['codex'],
        revision: 18, current_version_id: null })
      const inventory = await new PostgresSettingsRepository(database.pool).getManagedHarnessDefaults()
      expect(inventory.revision).toBe(17)
      expect(inventory.unavailable).toEqual(['codex'])
      expect(inventory.retiredDefaults).toEqual([{ instanceId: 'local-default:opencode', instanceRevision: '17',
        driverId: 'opencode', enabled: false, configuration: retiredConfiguration }])
      expect(inventory.defaults).not.toHaveProperty('opencode')

      const defaults = await new PostgresFoundationSettingsRepository(database.pool).getAgentDefaults()
      expect(defaults.revision).toBe(18)
      expect(defaults.versionId).not.toBe(historicalVersionId)
      const revisedDefaults = {
        orchestrator: { ...DEFAULT_AGENT_DEFAULTS.orchestrator, harness: replacementConfiguration },
        coder: { ...DEFAULT_AGENT_DEFAULTS.coder, harness: replacementConfiguration },
        operator: { ...DEFAULT_AGENT_DEFAULTS.operator, harness: replacementConfiguration },
      }
      for (const role of ['orchestrator', 'coder', 'operator'] as const) {
        expect(defaults.value[role].harness).toEqual(withAdvancedDefaults(replacementConfiguration))
        expect(defaults.value[role]).not.toHaveProperty('harnessProfileSelection')
      }
      const versions = await storedVersions()
      expect(versions).toEqual([
        { id: historicalVersionId, version: 17, record: historicalRoleDefaults },
        { id: defaults.versionId, version: 18, record: revisedDefaults },
      ])
      const retirementAudits = await audits()
      expect(retirementAudits).toEqual([{ principal_id: null, source: 'system', action: 'harness.defaults.retire',
        outcome: 'allowed', details: { previousRevision: 17, revision: 18 } }])

      const credentialRows = await storedCredentials()
      const revoked = credentialRows.find(row => row.token_hash === digest(revokedToken))!
      expect(new Date(revoked.revoked_at!).toISOString()).toBe(revokedAt)
      expect(credentialRows.find(row => row.token_hash === digest(liveToken))!.revoked_at).not.toBeNull()
      expect(credentialRows.find(row => row.token_hash === digest(supportedToken))!.revoked_at).toBeNull()
      for (const token of [liveToken, revokedToken]) {
        expect(await credentials.session(digest(token), new Date().toISOString())).toBeUndefined()
        await expect(sessions.authenticate(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
        await expect(sessions.authenticateSharedEndpoint(token)).rejects.toMatchObject({ code: 'FILE_SESSION_EXPIRED' })
      }
      expect((await sessions.authenticate(supportedToken)).context).toEqual(context)

      await applyApplicationMigrations(database.pool)
      expect(await savedFacts()).toEqual(historicalFacts)
      expect(await storedSettings()).toEqual(settings)
      expect(await storedVersions()).toEqual(versions)
      expect(await storedCredentials()).toEqual(credentialRows)
      expect(await audits()).toEqual(retirementAudits)
    } finally {
      await database.close()
    }
  },
  60_000,
)
