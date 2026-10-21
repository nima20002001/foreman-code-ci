import { workerToolServices } from './helpers/workerMcpServices.js'
import { afterEach, describe, expect, it } from 'vitest'
import { AppInteractionGetOutputSchema, AppInteractionListOutputSchema } from '@foreman-code/contracts'
import { buildApp } from '../src/app.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { selectedMainMcpForward } from '../src/modules/placement/workerMcpRelay.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { approvalDatabase } from './helpers/wave25ApprovalDatabase.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => { while (closes.length) await closes.pop()!() })

describe.skipIf(!postgresEnabled)('authenticated bounded interaction readback through selected Main', () => {
  it('persists on-request approval configuration for a read-only routed reviewer', async () => {
    const command = 'recorded readonly command'
    const f = await approvalDatabase({ command })
    closes.push(f.close)
    const workflows = new PostgresWorkflowRepository(f.pool)
    const configuration = await workflows.getAgentConfiguration(
      f.version.agentConfigurationVersionIds[f.reviewer.agentId]!,
    )
    expect(configuration?.harness).toMatchObject({
      harness: 'codex', sandbox: 'read-only',
      advanced: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
    })
    expect(await f.repository.get(f.interaction.id)).toMatchObject({
      request: { command },
      approval: { handler: 'orchestrator', designatedOrchestratorAgentId: f.reviewer.agentId },
      status: 'pending',
    })
  })

  it('retrieves an oversized persisted list and individual request, and denies out-of-scope chunks', async () => {
    // Stay above the relay limit without multiplying full-record reads for dense escaping.
    const command = `${'x'.repeat(4_000)}😀"\\\n`.repeat(250)
    const f = await approvalDatabase({ command })
    closes.push(f.close)
    const interaction = f.interaction
    expect(interaction.request).toMatchObject({ command })
    expect(Buffer.byteLength(JSON.stringify(interaction), 'utf8')).toBeGreaterThan(1_000_000)
    expect(await f.repository.get(interaction.id)).toEqual(interaction)
    const app = buildApp({
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      appMcp: workerToolServices(f.pool, f.commands).appMcp(f.access, new PostgresAppInteractionService(f.pool, f.repository, f.commands, f.service)),
    })
    await app.listen({ host: '127.0.0.1', port: 0 })
    closes.push(() => app.close())
    const forward = selectedMainMcpForward(app)
    let id = 0
    async function call(name: string, args: unknown, token = f.credential.environment.variables.GRAPHQL_MCP_TOKEN!) {
      const response = await forward.request({ jsonrpc: '2.0', id: ++id, method: 'tools/call',
        params: { name, arguments: args } }, token, '2025-03-26')
      expect(response.statusCode).toBe(200)
      expect(Buffer.byteLength(response.body, 'utf8')).toBeLessThan(1_000_000)
      const data = response.contentType === 'text/event-stream'
        ? response.body.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : response.body
      const envelope = JSON.parse(data)
      expect(envelope.id).toBe(id)
      return envelope.result as { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: unknown }
    }
    const list = await call('interaction_list', {})
    expect(list.isError).not.toBe(true)
    const listed = AppInteractionListOutputSchema.parse(JSON.parse(list.content[0]!.text))
    expect(listed.items).toContainEqual(expect.objectContaining({
      id: interaction.id, contentOmitted: true, responseOptions: interaction.responseOptions,
    }))
    let page = AppInteractionGetOutputSchema.parse((await call('interaction_get', {
      interactionId: interaction.id,
    })).structuredContent)
    const firstCursor = page.content!.nextCursor!
    expect(firstCursor).toEqual(expect.any(String))
    const totalCharacters = page.content!.totalCharacters
    const digest = page.content!.sha256
    let json = ''
    do {
      expect(page.content!.text.length).toBeGreaterThan(0)
      expect(page.content!.totalCharacters).toBe(totalCharacters)
      expect(page.content!.sha256).toBe(digest)
      json += page.content!.text
      expect(json.length).toBeLessThanOrEqual(totalCharacters)
      const contentCursor = page.content!.nextCursor
      if (!contentCursor) break
      page = AppInteractionGetOutputSchema.parse((await call('interaction_get', {
        interactionId: interaction.id, contentCursor,
      })).structuredContent)
    } while (json.length < page.content!.totalCharacters)
    expect(page.content!.nextCursor).toBeNull()
    expect(json).toHaveLength(totalCharacters)
    expect(JSON.parse(json).interaction).toEqual(interaction)
    expect(await f.repository.get(interaction.id)).toEqual(interaction)
    const outsider = await f.credentials.issueForReviewer(f.reviewer.id)
    await f.pool.query('update management_principals set grants=$2::jsonb where id=$1', [
      outsider.principalId, JSON.stringify([{ actions: ['interactions:read'], scope: {
        workspaceIds: [interaction.workspaceId], workflowIds: [interaction.workflowId], runIds: ['another-run'],
      } }]),
    ])
    const outsiderToken = outsider.environment.variables.GRAPHQL_MCP_TOKEN!
    const denied = await call('interaction_get', { interactionId: interaction.id, contentCursor: firstCursor }, outsiderToken)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('INTERACTION_NOT_FOUND')
    expect(denied.structuredContent).toBeUndefined()
    const deniedList = await call('interaction_list', {}, outsiderToken)
    expect(deniedList.structuredContent).toEqual({ items: [], nextCursor: null })
  }, 60_000)
})
