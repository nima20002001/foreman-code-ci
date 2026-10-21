import { decodeMcpToolResult, OperatorRunGetResultSchema } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedWorkspaceCommandResultSchema, ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema, makeCurrentWorkflowFixture }
  from '@foreman-code/contracts/wave25'
import { continuationValidator } from '../src/modules/runs/continuation.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { readCurrentExecutions } from './helpers/wave25Agent3.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('workspace folder dependencies retained by accepted Runs', () => {
  it('protects the original folder after a rebind, restores native continuation, and retries cleanup after settlement',
    async () => {
      const definition = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
      // Request approval on the first turn, before any predecessor needs to settle.
      const approvalNodeId = definition.version.entryNodeId
      const f = await currentOperatorIntegration({ fixture: definition, insertRun: false,
        approvalNodeIds: [approvalNodeId] })
      try {
        // This scenario uses real directory identities; only the external provider is deterministic.
        vi.mocked(f.locations.revalidateSnapshot).mockRestore()
        const parent = join(f.db.directory, 'workspaces')
        const replacement = join(parent, 'replacement')
        await mkdir(replacement, { recursive: true, mode: 0o700 })
        const defaults = new PostgresFoundationSettingsRepository(f.db.pool, parent)
        f.services.workspaces = new WorkspaceManagementService(f.db.pool, f.commands, f.locations, defaults, parent)
        const created = await f.client.callTool({ name: 'workspace_create', arguments: {
          commandId: randomUUID(), name: 'Owned folder', parentPath: parent,
        } })
        expect(created.isError, JSON.stringify(created)).not.toBe(true)
        const owner = ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(created)).value
        const project = owner.executionLocation!.rootPath
        await writeFile(join(project, 'input.txt'), 'original Run input')
        const workspaceId = f.f.scope.workspaceId
        const selected = await f.client.callTool({ name: 'workspace_location_set', arguments: {
          workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
          runnerId: f.locations.runnerId, rootPath: project,
        } })
        expect(selected.isError, JSON.stringify(selected)).not.toBe(true)
        const before = ManagedWorkspaceSchema.parse(decodeMcpToolResult((await f.client.callTool({ name: 'workspace_get',
          arguments: { workspaceId } }))))
        const savedResult = await f.client.callTool({ name: 'workflow_save_v3', arguments: {
          ...await f.create(),
        } })
        expect(savedResult.isError, JSON.stringify(savedResult)).not.toBe(true)
        const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResult)).value
        const start = {
          workspaceId, workflowId: saved.workflowId, workflowVersionId: saved.currentVersionId,
          executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: saved.revision,
          expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
          expectedLocationRevision: before.locationRevision, input: {},
        }
        const engineStart = f.engine.start.bind(f.engine)
        // Admission returns before execution; join the scheduled drive before inspecting its approval.
        const dispatched = new Promise<string>((resolve, reject) => {
          vi.spyOn(f.engine, 'start').mockImplementation((runId) => {
            const task = engineStart(runId)
            void task.then(() => resolve(runId), reject)
            return task
          })
        })
        const started = await f.client.callTool({ name: 'run_start', arguments: start })
        expect(started.isError, JSON.stringify(started)).not.toBe(true)
        const runId = RunStartV3ResultSchema.parse(decodeMcpToolResult(started)).run.id
        expect(await dispatched).toBe(runId)
        expect(await f.runs.get(runId)).toMatchObject({ executionState: 'waiting' })
        const acceptedRun = await f.client.callTool({ name: 'run_get', arguments: {
          workspaceId, runId, detail: 'full',
        } })
        expect(acceptedRun.isError, JSON.stringify(acceptedRun)).not.toBe(true)
        expect(OperatorRunGetResultSchema.parse(decodeMcpToolResult(acceptedRun))).toMatchObject({
          run: { id: runId, executionState: 'waiting', executionLocation: { rootPath: project } },
        })
        expect(f.dispatchErrors).toEqual([])
        const original = (await f.runs.getRepeatSnapshot(runId)).run
        const executions = await readCurrentExecutions(f.runs, runId)
        const pending = (await f.repository.list({ runId, limit: 100 })).find(item => item.status === 'pending')!
        expect(pending).toBeDefined()
        expect(pending.nativeRequestType).toBe('item/commandExecution/requestApproval')
        const waiting = executions.find(execution => execution.id === pending.executionId)!
        expect(waiting.workflowNodeId).toBe(approvalNodeId)
        expect(waiting.workingDirectory).toBe(project)
        await continuationValidator(f.db.pool, f.locations)(waiting.id)
        expect(await readFile(join(waiting.workingDirectory!, 'input.txt'), 'utf8')).toBe('original Run input')

        const rebound = await f.client.callTool({ name: 'workspace_location_set', arguments: {
          workspaceId, commandId: randomUUID(), expectedLocationRevision: before.locationRevision,
          runnerId: f.locations.runnerId, rootPath: replacement,
        } })
        expect(rebound.isError, JSON.stringify(rebound)).not.toBe(true)
        const archive = { workspaceId: owner.workspace.id, expectedRevision: owner.revision, commandId: randomUUID() }
        const reader = await f.access.issue({ name: 'Folder reader', audience: 'operator',
          expiresAt: new Date(Date.now() + 60_000), grants: [{
            actions: ['workspaces:read', 'workspace_locations:read'], scope: {},
          }] })
        const denied = await f.connect(reader.token)
        await expectMcpAccessDenied(denied.callTool({ name: 'workspace_archive', arguments: archive }))
        const unchangedOwner = await f.client.callTool({ name: 'workspace_get',
          arguments: { workspaceId: owner.workspace.id } })
        expect(ManagedWorkspaceSchema.parse(decodeMcpToolResult(unchangedOwner)).archivedAt).toBeNull()
        const blocked = await f.client.callTool({ name: 'workspace_archive', arguments: archive })
        expect(blocked.isError).toBe(true)
        expect(JSON.stringify(blocked.content)).toContain('WORKSPACE_FOLDER_CLEANUP_FAILED')
        expect(await readFile(join(project, 'input.txt'), 'utf8')).toBe('original Run input')
        const archivedOwner = await f.client.callTool({ name: 'workspace_get',
          arguments: { workspaceId: owner.workspace.id } })
        expect(ManagedWorkspaceSchema.parse(decodeMcpToolResult(archivedOwner)).archivedAt).not.toBeNull()
        const ownership = await f.db.pool.query<{ created_project_folder: { rootPath: string } }>(
          'select created_project_folder from workspaces where id=$1', [owner.workspace.id],
        )
        expect(ownership.rows[0]!.created_project_folder.rootPath).toBe(project)
        const read = await f.client.callTool({ name: 'workspace_get', arguments: { workspaceId } })
        expect(read.isError).not.toBe(true)
        expect(ManagedWorkspaceSchema.parse(decodeMcpToolResult(read))).toMatchObject({
          executionLocation: { rootPath: replacement }, locationRevision: before.locationRevision + 1,
        })
        expect((await f.runs.getRepeatSnapshot(runId)).run.executionLocation).toEqual(original.executionLocation)
        expect((await f.runs.getRepeatSnapshot(runId)).version).toEqual(saved.version)

        const counts = { ...f.provider.counts }
        await f.engine.shutdown()
        const runtime = f.compose()
        vi.mocked(runtime.locations.revalidateSnapshot).mockRestore()
        await continuationValidator(f.db.pool, runtime.locations)(waiting.id)
        await runtime.engine.start(runId)
        expect(await runtime.repository.get(pending.id)).toEqual(pending)
        expect(f.provider.counts.starts).toBe(counts.starts)
        expect(f.provider.counts.attaches).toBeGreaterThan(counts.attaches)
        expect(await readCurrentExecutions(runtime.runs, runId)).toEqual(executions)
        const responder = await f.access.issue({ name: 'Run approver', audience: 'user',
          expiresAt: new Date(Date.now() + 60_000), grants: [{
            actions: ['interactions:read', 'interactions:respond'], scope: { workspaceIds: [workspaceId], runIds: [runId] },
          }] })
        await runtime.service.respond({ kind: 'user', principal: responder.principal }, approvalResponse(pending))
        await vi.waitFor(async () => {
          expect(await runtime.runs.get(runId)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
          expect(await runtime.runs.hasPendingCleanup(runId)).toBe(false)
        }, { timeout: 10_000 })
        await runtime.runs.requestCleanup(runId)
        expect(await runtime.runs.hasPendingCleanup(runId)).toBe(true)
        const cleanupBlocked = await f.client.callTool({ name: 'workspace_archive', arguments: archive })
        expect(cleanupBlocked.isError).toBe(true)
        expect(JSON.stringify(cleanupBlocked.content)).toContain('WORKSPACE_FOLDER_CLEANUP_FAILED')
        expect(await readFile(join(project, 'input.txt'), 'utf8')).toBe('original Run input')
        await runtime.engine.resume(runId)
        expect(await runtime.runs.hasPendingCleanup(runId)).toBe(false)
        const retried = await f.client.callTool({ name: 'workspace_archive', arguments: archive })
        expect(retried.isError, JSON.stringify(retried)).not.toBe(true)
        expect(ManagedWorkspaceCommandResultSchema.parse(decodeMcpToolResult(retried)).replayed).toBe(true)
        await expect(lstat(project)).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await runtime.runs.getRepeatSnapshot(runId)).run.executionLocation).toEqual(original.executionLocation)
        expect((await runtime.runs.getRepeatSnapshot(runId)).version).toEqual(saved.version)
        const removedOwnership = await f.db.pool.query<{ created_project_folder: unknown }>(
          'select created_project_folder from workspaces where id=$1', [owner.workspace.id],
        )
        expect(removedOwnership.rows[0]!.created_project_folder).toBeNull()
        const audit = await f.db.pool.query<{ outcome: string }>(
          `select outcome from management_audit where action='workspace.folder.cleanup'
           and details->>'commandId'=$1 order by sequence`, [archive.commandId],
        )
        expect(audit.rows.map(row => row.outcome)).toContain('failed')
        expect(audit.rows.map(row => row.outcome)).toContain('succeeded')
      } finally {
        await f.close()
      }
    }, 90_000)
})
