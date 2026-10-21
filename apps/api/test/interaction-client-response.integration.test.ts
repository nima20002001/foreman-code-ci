import { expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { PostgresWorkspaceRepository } from '../src/modules/workspaces/postgres.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { approvalResponse } from './helpers/approvalResponse.js'

it.each(['operator', 'local operator', 'human'] as const)(
  'routes the web %s response through Fastify with persisted readback and denial', async kind => {
  const f = await codexApprovalRuntime('user')
  const workflows = new PostgresWorkflowRepository(f.db.pool)
  const writer = await f.access.issue({ name: 'Interaction writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [f.f.run.id] } },
      { actions: ['capabilities:read'], scope: {} }] })
  const reader = await f.access.issue({ name: 'Interaction reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['interactions:read'], scope: { runIds: [f.f.run.id] } },
      { actions: ['capabilities:read'], scope: {} }] })
  const app = buildApp({
    product: { workspaces: new PostgresWorkspaceRepository(f.db.pool, workflows, f.runs), workflows,
      runs: f.runs, engine: f.engine, interactions: f.service },
    localHuman: { current: async () => writer.principal },
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { commands: new PostgresCommandCoordinator(f.db.pool),
      interactions: new OperatorInteractionService(f.service) } as unknown as OperatorServices },
  })
  const clients: Client[] = []
  try {
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    if (!interaction) throw new Error('Expected a pending native request')
    // Load the browser client at runtime; it remains outside the API build output.
    const webClientModule = new URL('../../web/src/shared/api/client.ts', import.meta.url).href
    const { ApiClient } = await import(webClientModule)
    const web = new ApiClient({ baseUrl: 'http://localhost',
      fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST',
          url: new URL(String(input)).pathname, headers: Object.fromEntries(new Headers(init?.headers)),
          ...(typeof init?.body === 'string' ? { payload: init.body } : {}) })
        return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } })
      },
    })
    const input = approvalResponse(interaction)
    const operator = kind !== 'human'
    const respond = operator ? web.respondToInteraction.bind(web) : web.respondToUserInteraction.bind(web)
    await expect(respond(input, { headers: { authorization: `Bearer ${reader.token}` } })).rejects.toMatchObject({ status: 403 })
    const options = kind === 'operator' ? { headers: { authorization: `Bearer ${writer.token}` } } : {}
    await expect(respond({ ...input, expectedRevision: interaction.revision + 1 }, options)).rejects.toMatchObject({ status: 409 })
    expect(f.counts().responses).toBe(0)
    const result = await respond(input, options)
    expect(result.interaction).toMatchObject({ selectedOptionId: input.optionId, status: 'delivered' })
    expect(await f.repository.get(interaction.id)).toEqual(result.interaction)
    const readback = operator ? await web.getInteraction(interaction.id, options) : await web.getUserInteraction(interaction.id)
    expect(readback.interaction).toEqual(result.interaction)
    expect((await respond(input, options)).replayed).toBe(true)
    expect(f.counts().responses).toBe(1)

    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    for (const caller of [writer, reader]) {
      const client = new Client({ name: 'interaction-response', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => caller.token },
      }))
    }
    expect((await clients[1]!.callTool({ name: 'interaction_respond', arguments: input })).isError).toBe(true)
    const persisted = await clients[0]!.callTool({ name: 'interaction_get', arguments: { interactionId: interaction.id } })
    expect(persisted.isError).not.toBe(true)
    expect(decodeMcpToolResult(persisted)).toMatchObject({ interaction: result.interaction })
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await app.close()
    await f.close()
  }
}, 60_000)
