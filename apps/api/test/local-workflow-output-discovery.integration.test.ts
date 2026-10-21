import { workerToolServices } from './helpers/workerMcpServices.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS, HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES } from '@foreman-code/contracts/worker-native-output'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { insertProviderRun } from './helpers/wave25Br1003Runtime.js'
import { candidateFor, seedAgent3 } from './helpers/wave25Agent3.js'

it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  'keeps retired local output tools unavailable and rejects revoked or unrelated worker callers', async () => {
    const db = await currentDatabase()
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const f = makeCurrentWorkflowFixture(randomUUID(), 'single')
      f.configurations = f.configurations.map(configuration => AgentConfigurationVersionSchema.parse({
        ...configuration, harness: structuredClone(DEFAULT_HARNESS_DEFAULTS.codex),
        graphqlTools: ['context_get', ...Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES)],
      }))
      f.version.definition.nodes[0]!.artifactOutputs = { version: 1, outputKeys: ['report'] }
      await seedAgent3(db.pool, db.directory, f, { run: false })
      const access = new PostgresAccessService(db.pool)
      const owner = await access.issue({ name: 'Output discovery owner', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{
          actions: ['runs:start', 'workspace_locations:read', 'agent_chat:read', 'agent_chat:write'],
          scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] },
        }],
      })
      f.run = WorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: owner.principal.id,
        executionLocation: { ...f.run.executionLocation, runnerId: 'runner-local' },
      })
      await insertProviderRun(db.pool, f)
      await db.pool.query(`update runs set execution_state='running',
        record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [f.run.id])
      const execution = HarnessExecutionSchema.parse({ ...candidateFor(f), state: 'starting' })
      await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values($1,$2,$3,$4,1,$5::jsonb)`, [execution.id, f.run.id, execution.workflowNodeId,
        execution.agentId, JSON.stringify(execution)])
      const credential = await new Wave25WorkerCredentialService(db.pool, access).issueForExecution(execution.id)
      const commands = new PostgresCommandCoordinator(db.pool)
      app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
        appMcp: workerToolServices(db.pool, commands).appMcp(access, new PostgresAppInteractionService(db.pool, {} as never, commands)),
      })
      const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
      const connect = async (token: string) => {
        const client = new Client({ name: 'Output discovery regression', version: '1.0.0' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint),
          { authProvider: { token: async () => token } }))
        return client
      }
      const worker = await connect(credential.environment.variables.GRAPHQL_MCP_TOKEN!)
      const outputs = Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES)
      const tools = (await worker.listTools()).tools.map(tool => tool.name)
      expect(tools).toEqual(expect.arrayContaining(['bug_report', 'context_get']))
      for (const output of outputs) expect(tools).not.toContain(output)
      const denied = await worker.callTool({ name: WORKER_NATIVE_OUTPUT_TOOL_NAMES.create,
        arguments: { commandId: randomUUID(), filename: 'report.md', mediaType: 'text/markdown' } })
      expect(denied.isError).toBe(true)
      const failure = denied.content.find(value => value.type === 'text')
      if (failure?.type !== 'text') throw new Error('The retired tool denial needs an MCP error body')
      expect(JSON.parse(failure.text)).toMatchObject({ error: { code: 'TOOL_NOT_ENABLED' } })
      expect((await db.pool.query('select * from local_workflow_native_outputs')).rows).toEqual([])
      const unrelated = await access.issue({ name: 'Unbound read-only worker', audience: 'worker', agentId: execution.agentId,
        expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['interactions:read'],
          scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId], runIds: [f.run.id] } }],
      })
      const list = (token: string) => app!.inject({ method: 'POST', url: '/mcp',
        headers: { authorization: `Bearer ${token}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      })
      const unbound = await list(unrelated.token)
      expect(unbound.statusCode).toBe(401)
      expect(unbound.json()).toMatchObject({ error: { code: 'AUTH_REVOKED' } })
      await db.pool.query("update harness_executions set record=jsonb_set(record,'{state}','\"running\"') where id=$1",
        [execution.id])
      const unadmitted = await list(credential.environment.variables.GRAPHQL_MCP_TOKEN!)
      expect(unadmitted.statusCode).toBe(401)
      expect(unadmitted.json()).toMatchObject({ error: { code: 'AUTH_REVOKED' } })
      await db.pool.query("update harness_executions set record=jsonb_set(record,'{state}','\"starting\"') where id=$1",
        [execution.id])
      await db.pool.query('update worker_credential_bindings set revoked_at=clock_timestamp() where principal_id=$1',
        [credential.principalId])
      const revoked = await list(credential.environment.variables.GRAPHQL_MCP_TOKEN!)
      expect(revoked.statusCode).toBe(401)
      expect(revoked.json()).toMatchObject({ error: { code: 'AUTH_REVOKED' } })
      expect((await db.pool.query('select * from local_workflow_native_outputs')).rows).toEqual([])
    } finally {
      for (const client of clients) await client.close()
      try { await app?.close() }
      finally { await db.close() }
    }
  }, 120_000)
