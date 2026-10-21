import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { expect, it } from 'vitest'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { ExecutionReadinessSchema } from '@foreman-code/contracts/management'
import { ExecutionReadinessService } from '../src/modules/harnesses/executionReadiness.js'
import { NativeRollout } from '../src/modules/harnesses/nativeRollout.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { DomainError } from '../src/modules/errors.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { buildApp } from '../src/app.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { authorizeOperatorConfigurationRead } from '../src/modules/operators/configurationRead.js'
import { operatorChatGrants } from '../src/modules/access/operatorChatDelegation.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'

// Real authenticated HTTP/MCP and persisted configuration; the native qualifier
// is the existing provider fixture, not evidence of a real Claude native turn.
it.skipIf(!postgresEnabled)('reads the exact persisted Operator readiness through HTTP and MCP without writes, and denies ungranted callers', async () => {
  const f = await currentOperatorIntegration()
  const operators = new PostgresOperatorRepository(f.db.pool)
  const settings = new PostgresFoundationSettingsRepository(f.db.pool)
  const clients: Client[] = []
  let app: ReturnType<typeof buildApp> | undefined
  try {
    const { configuration } = await operators.ensure()
    const defaults = await settings.getAgentDefaults()
    const executionReadiness = new ExecutionReadinessService(new NativeRollout({ NODE_ENV: 'production',
      GRAPHQL_LOCAL_PRODUCTION: '1', HOST: '127.0.0.1', DATABASE_URL: process.env.TEST_DATABASE_URL }),
    f.services.harnesses, async (principal, id) => {
      principal = await f.access.currentHarnessInspectionPrincipal(principal.id)
      if (id) await authorizeOperatorConfigurationRead(f.db.pool, principal, id)
      const selected = id ? await f.db.pool.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1', [id]) : undefined
      if (id && !selected?.rows[0]) throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The pinned configuration is missing.', 409)
      const current = id ? OperatorConfigurationVersionSchema.parse(selected!.rows[0]!.record)
        : await operators.inspectionConfiguration(defaults.revision)
      await f.services.harnesses.checkConfiguration(principal, current.harness)
      return { configurationVersionId: current.id, harness: current.harness, defaultsRevision: id ? null : defaults.revision }
    })
    app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access: f.access, services: { ...f.services, executionReadiness } } })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'operator-readiness-test', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(f.writer.token)
    const before = await f.db.pool.query('select id,record from operator_configuration_versions order by id')
    const read = async (id?: string) => {
      const result = await client.callTool({ name: 'execution_readiness_get', arguments: {
        harness: configuration.harness.harness, scope: 'operator-configuration', ...(id ? { configurationVersionId: id } : {}),
      } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      return ExecutionReadinessSchema.parse(decodeMcpToolResult(result))
    }
    expect(await read()).toMatchObject({ status: 'eligible', scope: 'operator-configuration', defaultsRevision: defaults.revision,
      configurationVersionId: configuration.id })
    expect(await read(configuration.id)).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id, defaultsRevision: null })
    expect(await read(configuration.id)).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id })
    const missing = await client.callTool({ name: 'execution_readiness_get', arguments: {
      harness: configuration.harness.harness, scope: 'operator-configuration', configurationVersionId: 'missing-config',
    } })
    expect(missing.isError).toBe(true); expect(JSON.stringify(missing)).toContain('ACCESS_DENIED')
    const url = new URL(`/api/management/harnesses/${configuration.harness.harness}/execution-readiness`, address)
    url.searchParams.set('scope', 'operator-configuration'); url.searchParams.set('configurationVersionId', configuration.id)
    const response = await fetch(url, { headers: { authorization: `Bearer ${f.writer.token}` } })
    expect(response.status).toBe(200)
    expect(ExecutionReadinessSchema.parse(await response.json())).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id })
    const denied = await f.access.issue({ name: 'No readiness grant', audience: 'operator', expiresAt: new Date(Date.now() + 600000), grants: [] })
    expect((await fetch(url, { headers: { authorization: `Bearer ${denied.token}` } })).status).toBe(403)
    await expectMcpAccessDenied((await connect(denied.token)).callTool({ name: 'execution_readiness_get', arguments: {
      harness: configuration.harness.harness, scope: 'operator-configuration',
    } }))
    expect((await f.db.pool.query('select id,record from operator_configuration_versions order by id')).rows).toEqual(before.rows)
    expect(await settings.getAgentDefaults()).toEqual(defaults)

    // Move the public default after recording the original pin in an owned
    // conversation. A different reader may inspect the public default, but
    // cannot borrow the private historical configuration or its host profile.
    const conversations = new PostgresOperatorConversationRepository(f.db.pool)
    const owned = await conversations.create(configuration.operatorId, configuration, f.writer.principal.id)
    const changedHarness = { ...configuration.harness, model: 'fixture-next-model' }
    await settings.updateAgentDefaults({ ...defaults.value, operator: { ...defaults.value.operator, harness: changedHarness } }, defaults.revision)
    const next = await operators.update(changedHarness, configuration.id)
    expect(await read(configuration.id)).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id })
    const other = await f.access.issue({ name: 'Other readiness reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['harnesses:read', 'operator_chat:read'], scope: {} }] })
    expect((await fetch(url, { headers: { authorization: `Bearer ${other.token}` } })).status).toBe(403)
    const privatePin = await (await connect(other.token)).callTool({ name: 'execution_readiness_get', arguments: {
      harness: configuration.harness.harness, scope: 'operator-configuration', configurationVersionId: configuration.id,
    } })
    expect(privatePin.isError).toBe(true); expect(JSON.stringify(privatePin)).toContain('ACCESS_DENIED')
    const publicReader = await f.access.issue({ name: 'Public harness metadata reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['harnesses:read'], scope: {} }] })
    url.searchParams.set('configurationVersionId', next.configuration.id)
    expect((await fetch(url, { headers: { authorization: `Bearer ${publicReader.token}` } })).status).toBe(200)
    // A real chat-bound credential keeps its own principal and narrowed grant
    // ceiling. Admit/bind/submit the turn through the repository state machine.
    const requestId = 'active-inspection-turn'
    await conversations.beginTurn(owned.id, { requestId, content: 'Inspect my pinned configuration.' }, f.writer.principal.id)
    await conversations.bind(owned.id, requestId, 'fixture', 'inspection-native-session')
    expect(await conversations.submitted(owned.id, requestId, 'inspection-native-turn', {
      nativeSessionId: 'inspection-native-session', principalId: f.writer.principal.id,
    })).toBe(true)
    const delegate = await f.access.issue({ name: 'Bound inspection delegate', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: operatorChatGrants(f.writer.principal.grants) })
    await f.db.pool.query('update management_principals set delegated_from=$2 where id=$1', [delegate.principal.id, f.writer.principal.id])
    await f.db.pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)', [delegate.principal.id, owned.id])
    const delegated = await connect(delegate.token)
    const inspect = (id = configuration.id) => delegated.callTool({ name: 'execution_readiness_get', arguments: {
      harness: configuration.harness.harness, scope: 'operator-configuration', configurationVersionId: id,
    } })
    expect((await f.access.currentHarnessInspectionPrincipal(delegate.principal.id)).id).toBe(delegate.principal.id)
    expect((await f.access.currentHarnessInspectionPrincipal(delegate.principal.id)).grants.flatMap(grant => grant.actions)).not.toContain('operator_chat:read')
    const historical = await inspect()
    expect(historical.isError, JSON.stringify(historical)).not.toBe(true)
    expect(ExecutionReadinessSchema.parse(decodeMcpToolResult(historical))).toMatchObject({ status: 'eligible', configurationVersionId: configuration.id })
    const foreign = await conversations.create(configuration.operatorId, next.configuration, other.principal.id)
    await operators.update({ ...changedHarness, model: 'fixture-third-model' }, next.configuration.id)
    const foreignRead = await inspect(next.configuration.id)
    expect(foreignRead.isError).toBe(true); expect(JSON.stringify(foreignRead)).toContain('ACCESS_DENIED')
    const deniedInspection = async () => {
      const result = await inspect().then(reply => {
        expect(reply.isError).toBe(true)
        return JSON.stringify(reply)
      }, error => String(error))
      expect(result).toMatch(/401|Unauthorized|AUTH_|revoked/i)
      expect((await fetch(url, { headers: { authorization: `Bearer ${delegate.token}` } })).status).toBe(401)
    }
    await conversations.beginTurn(foreign.id, { requestId: 'foreign-turn', content: 'Inspect another pin.' }, other.principal.id)
    await conversations.bind(foreign.id, 'foreign-turn', 'fixture', 'foreign-native-session')
    expect(await conversations.submitted(foreign.id, 'foreign-turn', 'foreign-native-turn', {
      nativeSessionId: 'foreign-native-session', principalId: other.principal.id,
    })).toBe(true)
    // Rebinding to a foreign owner is denied by authenticated/live inspection.
    await f.db.pool.query('update operator_chat_credentials set conversation_id=$2 where principal_id=$1', [delegate.principal.id, foreign.id])
    await deniedInspection()
    await f.db.pool.query('update operator_chat_credentials set conversation_id=$2 where principal_id=$1', [delegate.principal.id, owned.id])
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [delegate.principal.id, JSON.stringify([{ actions: ['harnesses:read'], scope: {} }])])
    const missingRead = await inspect()
    expect(missingRead.isError).toBe(true); expect(JSON.stringify(missingRead)).toContain('ACCESS_DENIED')
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [delegate.principal.id, JSON.stringify(operatorChatGrants(f.writer.principal.grants))])
    await conversations.requestCancel(owned.id, requestId)
    const ended = await inspect()
    expect(ended.isError).toBe(true); expect(JSON.stringify(ended)).toContain('AUTH_CHAT_ENDED')
    await f.db.pool.query("update operator_conversations set cancel_requested=false,turn_state='active' where id=$1", [owned.id])
    await f.access.revoke(f.writer.principal.id)
    await deniedInspection()
    await f.db.pool.query('update management_principals set revoked_at=null where id=$1', [f.writer.principal.id])
    await f.db.pool.query("update management_principals set expires_at=now()-interval '1 second' where id=$1", [delegate.principal.id])
    await deniedInspection()
    await f.db.pool.query("update management_principals set expires_at=now()+interval '10 minutes' where id=$1", [delegate.principal.id])
    await f.access.revoke(delegate.principal.id)
    await deniedInspection()
    await f.db.pool.query('update management_principals set revoked_at=null where id=$1', [delegate.principal.id])
    expect(await conversations.journalTerminal(owned.id, requestId, { outcome: 'canceled' }, {
      retryable: false, requiresRuntimeClosure: true,
    })).toBe(true)
    expect(await conversations.closurePending(owned.id, requestId)).toBe(true)
    expect(await conversations.closureProven(owned.id, requestId)).toBe(true)
    expect(await conversations.finish(owned.id, requestId, { outcome: 'canceled' })).toBe(true)
    const completed = await inspect()
    expect(completed.isError).toBe(true); expect(JSON.stringify(completed)).toContain('AUTH_CHAT_ENDED')
    await conversations.setDeleted(owned.id, f.writer.principal.id, true)
    url.searchParams.set('configurationVersionId', configuration.id)
    expect((await fetch(url, { headers: { authorization: `Bearer ${f.writer.token}` } })).status).toBe(403)
  } finally { await Promise.allSettled(clients.map(client => client.close())); await app?.close(); await f.close() }
}, 60000)
