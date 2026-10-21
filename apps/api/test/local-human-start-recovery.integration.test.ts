import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { CurrentWorkflowSaveResultSchema, makeCurrentWorkflowFixture, RunStartV3InputSchema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { browserOwnerUpgrade } from './helpers/browserOwnerUpgrade.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('local human Start recovery', { timeout: 60_000 }, () => {
  it.concurrent.each(['mapped owner', 'default development browser'] as const)(
    'reconciles a lost Start response for %s after upgrade and restart without another native execution', async identity => {
    const fixture = await currentOperatorIntegration({
      fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'), approvalNodeIds: [],
    })
    let restarted: ReturnType<typeof buildApp> | undefined
    try {
      if (identity === 'default development browser') {
        const id = 'principal-local-development-browser'
        await fixture.db.pool.query('update management_principals set id=$1 where id=$2',
          [id, fixture.writer.principal.id])
        fixture.writer.principal.id = id
      }
      vi.mocked(fixture.locations.revalidateSnapshot).mockRestore()
      const location = await fixture.locations.set(fixture.writer.principal, 'http', {
        workspaceId: fixture.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
        runnerId: fixture.locations.runnerId, rootPath: fixture.db.directory,
      })
      const candidate = await fixture.create()
      const save = await fetch(new URL(
        `/api/management/workspaces/${candidate.workspaceId}/workflows/${candidate.workflowId}/definition`,
        fixture.address), { method: 'PUT',
        headers: { authorization: `Bearer ${fixture.writer.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(candidate),
      })
      const savedBody = await save.json()
      expect(save.status, JSON.stringify(savedBody)).toBe(200)
      const saved = CurrentWorkflowSaveResultSchema.parse(savedBody).value
      const input = RunStartV3InputSchema.parse({
        workspaceId: saved.version.workspaceId,
        workflowId: saved.version.workflowId,
        workflowVersionId: saved.currentVersionId,
        executionSemanticsVersion: 3,
        commandId: randomUUID(),
        expectedWorkflowRevision: saved.revision,
        expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        expectedLocationRevision: location.value.locationRevision,
        input: { user: 'Original Start journal' },
      })
      const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`
      await browserOwnerUpgrade(fixture.db.pool, fixture.writer.principal.id,
        { ownerMapping: identity === 'mapped owner' ? 'present' : 'empty' })
      // Discard the response; reconciliation has only the original command journal.
      const response = await fetch(new URL(path, fixture.address), { method: 'POST',
        headers: { authorization: `Bearer ${fixture.writer.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(input) })
      expect(response.status, response.status === 202 ? undefined : await response.text()).toBe(202)
      await response.body?.cancel()
      const readReceipt = async () => (await fixture.db.pool.query<{ result: { id: string } }>(
        "select result from management_command_receipts where principal_id=$1 and operation='run.start' and command_id=$2",
        [fixture.writer.principal.id, input.commandId],
      )).rows[0]!.result
      const original = await readReceipt()
      // Start reuses the active task for this Run, including its cleanup and owner release.
      let settleTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          fixture.engine.start(original.id),
          new Promise<never>((_resolve, reject) => {
            settleTimer = setTimeout(() => reject(new Error('The original Run did not settle.')), 20_000)
          }),
        ])
      } finally {
        clearTimeout(settleTimer)
      }
      expect((await fixture.runs.get(original.id))?.executionState).toBe('completed')
      await fixture.app.close()
      await fixture.engine.shutdown()
      const starts = fixture.provider.counts.starts
      const executions = await fixture.runs.listRepeatExecutions(original.id)
      await applyApplicationMigrations(fixture.db.pool)
      expect(await new PostgresLocalHumanAccess(fixture.db.pool, fixture.access).current())
        .toEqual(fixture.writer.principal)
      const runtime = fixture.compose()
      vi.mocked(runtime.locations.revalidateSnapshot).mockRestore()
      const access = new PostgresAccessService(fixture.db.pool)
      const commands = new PostgresCommandCoordinator(fixture.db.pool)
      const binding = createCurrentNativeProductionFactory({ isRuntimeOpen: () => true,
        reportDispatchFailure: (_id, code) => { throw new Error(code) } })({
        primaryPool: fixture.db.pool, commands, runs: runtime.runs, workflows: runtime.workflows,
        locations: runtime.locations, engine: runtime.engine, nativeExecutions: runtime.native,
        interactions: runtime.service, checkpointer: runtime.checkpointer,
      })
      const runs = new RunManagementService(fixture.db.pool, commands, runtime.runs,
        runtime.engine, runtime.locations, binding)
      restarted = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { ...fixture.services, commands, runs } },
        localHuman: new PostgresLocalHumanAccess(fixture.db.pool, access) })
      const recovered = await restarted.inject({ method: 'POST', url: path, payload: input })
      expect(recovered.statusCode, recovered.body).toBe(202)
      expect(recovered.json()).toMatchObject({ accepted: true, replayed: true, run: { id: original.id } })
      expect(await readReceipt()).toEqual(original)
      expect(await runtime.runs.listRepeatExecutions(original.id)).toEqual(executions)
      expect(fixture.provider.counts.starts).toBe(starts)
      expect((await fixture.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows)
        .toEqual([{ id: original.id }])
      const conflict = await restarted.inject({ method: 'POST', url: path,
        payload: { ...input, input: { user: 'Changed journal' } } })
      expect(conflict.statusCode).toBe(409)
    } finally {
      await restarted?.close()
      await fixture.close()
    }
  })
})
