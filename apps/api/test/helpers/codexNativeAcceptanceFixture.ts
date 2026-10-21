import { workerToolServices } from './workerMcpServices.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION, HarnessExecutionSchema,
  type HarnessExecutionRequest } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService as WorkerCredentialService } from '../../src/modules/interactions/wave25/credentials.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { AppMcpRoutes } from '../../src/modules/harnesses/appMcpRoutes.js'
import { installAppLauncher } from '../../src/modules/harnesses/appMcpLauncher.js'
import { PostgresAppInteractionService } from '../../src/modules/interactions/app.js'
import { PostgresInteractionRepository } from '../../src/modules/interactions/postgres.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'

/** Real execution-bound credentials and authenticated MCP; no ambient token or authority is borrowed. */
export async function codexNativeAcceptanceFixture(approvalPolicy: 'never' | 'on-request' = 'never') {
  const database = await agent3Database(process.env.ENG03_A_TEST_DATABASE_URL)
  const { pool, directory } = database
  const workingDirectory = join(directory, 'work')
  await mkdir(workingDirectory, { mode: 0o700 })
  const fixture = makeCurrentWorkflowFixture(randomUUID())
  fixture.configurations = fixture.configurations.map(base => {
    const content = { prompt: { system: 'Follow explicit shell instructions by using the native shell tool; never simulate tool results.' },
      assignedSkills: [], harness: { harness: 'codex', model: process.env.CODEX_MODEL ?? 'gpt-6-luna',
        reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard',
        advanced: { ...structuredClone(DEFAULT_CODEX_ADVANCED_CONFIGURATION), approvalPolicy } } }
    return AgentConfigurationVersionSchema.parse({ ...base, ...content, contentHash: `sha256:${commandInputHash(content)}` })
  })
  let app: ReturnType<typeof buildApp> | undefined
  let routes: AppMcpRoutes | undefined
  const access = new PostgresAccessService(pool)
  const credentials = new WorkerCredentialService(pool, access)
  let principalId: string | undefined
  const close = async () => {
    try { if (principalId) await credentials.revoke({ principalId }) }
    finally {
      try { await routes?.close() }
      finally {
        try { await app?.close() }
        finally { await database.close() }
      }
    }
  }
  try {
    await seedAgent3(pool, workingDirectory, fixture)
    const configuration = fixture.configurations[0]!
    const node = fixture.version.definition.nodes.find(row => row.agentId === configuration.agentId)
    assert(node)
    const run = WorkflowRunV3Schema.parse({ ...fixture.run, executionState: 'running' })
    await pool.query('update runs set execution_state=$2,record=$3 where id=$1', [run.id, run.executionState, run])
    const execution = HarnessExecutionSchema.parse({ id: randomUUID(), runId: run.id, workflowNodeId: node.id,
      agentId: configuration.agentId, agentConfigurationVersionId: configuration.id, attempt: 1,
      input: {}, state: 'starting', createdAt: new Date().toISOString(), workingDirectory, runtimeDirectory: directory })
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,accepted,record)
      values($1,$2,$3,$4,$5,false,$6)`,
    [execution.id, execution.runId, execution.workflowNodeId, execution.agentId, execution.attempt, execution])
    const issued = await credentials.issueForExecution(execution.id)
    principalId = issued.principalId
    const principal = await access.authenticate(issued.environment.variables.GRAPHQL_MCP_TOKEN, 'worker')
    assert.equal(principal.agentId, configuration.agentId)
    assert(principal.grants.every(grant => grant.actions.every(action => action === 'interactions:read')))
    const commands = new PostgresCommandCoordinator(pool)
    app = buildApp({ logger: false, readiness: { database: { ping: async () => { await pool.query('select 1') } },
      checkpoints: { ping: async () => {} } }, appMcp: workerToolServices(pool, commands).appMcp(access,
      new PostgresAppInteractionService(pool, new PostgresInteractionRepository(pool), commands)) })
    const endpoint = `${await app.listen({ host: '127.0.0.1', port: 0 })}/mcp`
    await installAppLauncher()
    routes = new AppMcpRoutes(pool, endpoint)
    await routes.refresh()
    const request: HarnessExecutionRequest = { executionId: execution.id, runId: run.id, workspaceId: run.workspaceId,
      workflowNodeId: node.id, workingDirectory, runtimeDirectory: directory, input: {}, configuration }
    return { directory, workingDirectory, input: { request, environment: issued.environment }, close }
  } catch (error) {
    await close()
    throw error
  }
}
