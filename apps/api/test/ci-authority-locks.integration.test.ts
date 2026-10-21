import { describe, expect, it } from 'vitest'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { acceptRunAuthority, bindRunAuthority } from '../src/modules/access/runAuthority.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { createTestPool } from './helpers/testPool.mjs'
import { agent3Database, candidateFor, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('CI authority reads beside credential admission', () => {
  it('resolves live Worker CI reads while publication locks the Run, execution and credential rows', async () => {
    const database = await agent3Database()
    const pool = createTestPool({ connectionString: database.databaseUrl,
      options: '-c lock_timeout=500 -c statement_timeout=5000' })
    try {
      const fixture = await seedAgent3(database.pool, database.directory)
      await pool.query(`update runs set execution_state='running',
        record=jsonb_set(record,'{executionState}','"running"'::jsonb) where id=$1`, [fixture.run.id])
      const execution = { ...candidateFor(fixture), state: 'running', startedAt: fixture.createdAt,
        nativeSessionId: 'credential-session' }
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values($1,$2,$3,$4,1,$5::jsonb)`,
      [execution.id, execution.runId, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
      const coordination = new PostgresInteractionCoordinationRepository(pool)
      const session = { harness: fixture.configurations[0]!.harness.harness,
        providerVersion: 'fixture-provider', nativeSessionId: execution.nativeSessionId }
      await coordination.bindWorkflowSession(execution.id, session)
      await coordination.ensureLane({ id: 'credential-lane', harness: session.harness,
        nativeSessionId: session.nativeSessionId, ownerAgentId: execution.agentId,
        observedStatus: 'busy', connectionGeneration: 1, revision: 0, observedAt: fixture.createdAt })
      await new PostgresApprovalBudgetRepository(pool).ensure(execution.id, 'credential-thread', 60_000)
      // Give the accepted Run owner the CI actions exercised below.
      await pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [fixture.run.authorizationPrincipalId, JSON.stringify([{ actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS],
          scope: { workspaceIds: [fixture.scope.workspaceId] } }])])
      const access = new PostgresAccessService(pool)
      const caller = await access.currentOperator(fixture.run.authorizationPrincipalId!)
      const accepted = await withTransaction(pool, async sql => {
        const accepted = await acceptRunAuthority(sql, caller)
        await bindRunAuthority(sql, fixture.run.id, accepted)
        await sql.query(`update runs set record=jsonb_set(record,'{authorizationPrincipalId}',to_jsonb($2::text)) where id=$1`,
          [fixture.run.id, accepted.principal.id])
        return accepted
      })
      const credentials = new Wave25WorkerCredentialService(pool, access)
      const issued = await credentials.issueForExecution(execution.id)
      const worker = await access.authenticate(issued.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker')
      const authority = new RunCiAuthority(pool)
      await withTransaction(pool, async writer => {
        await writer.query('select id from runs where id=$1 for update', [fixture.run.id])
        await writer.query('select id from harness_executions where id=$1 for update', [execution.id])
        await writer.query('select execution_id from execution_native_sessions where execution_id=$1 for update', [execution.id])
        await writer.query('select id from native_session_lanes where native_session_id=$1 for update', [session.nativeSessionId])
        await writer.query('select execution_id from approval_execution_state where execution_id=$1 for update', [execution.id])
        await writer.query('select principal_id from worker_credential_bindings where principal_id=$1 for update', [worker.id])
        await writer.query('select id from management_principals where id=$1 for update', [worker.id])
        await writer.query('select run_id from run_authority_principals where run_id=$1 for update', [fixture.run.id])
        for (const actions of [CI_RUN_ACTIONS, CI_GET_ACTIONS]) {
          const reads = await Promise.all(Array.from({ length: actions === CI_GET_ACTIONS ? 8 : 1 },
            () => authority.resolve(worker, undefined, actions)))
          for (const read of reads) expect(read).toMatchObject({
            workspaceId: fixture.scope.workspaceId, principal: { id: accepted.principal.id },
            executionId: execution.id, initiatingAgent: { runId: fixture.run.id, agentId: execution.agentId },
          })
        }
      })
      await credentials.revoke({ principalId: worker.id })
      await expect(authority.resolve(worker, undefined, CI_GET_ACTIONS)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    } finally {
      await pool.end()
      await database.close()
    }
  })
})
