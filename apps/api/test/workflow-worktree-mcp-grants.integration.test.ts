import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CurrentEditReadResultSchema } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { setup } from './helpers/workflowWorktreeMcp.js'

describe.runIf(postgresEnabled)('workflow worktrees through authenticated MCP: grants', () => {
  it.each(['sources:read', 'source_roots:read', 'workspace_locations:read'] as const)(
  'reauthorizes worktree edit receipts after removal of %s', async missing => {
    const f = await setup()
    try {
      const { saveInput } = await f.create()
      const saved = (await f.save(saveInput)).value
      const stage = { ...saveInput, action: 'stage_edits', draftId: randomUUID(), commandId: randomUUID(),
        expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
        graph: { ...saved.version.definition, defaultWorktree: {
          rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/staged',
        } } }
      const callEdit = async (input: Record<string, unknown>) => {
        const result = await f.base.client.callTool({ name: 'workflow_edit_v3', arguments: input })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        return CurrentEditReadResultSchema.parse(decodeMcpToolResult(result))
      }
      const setGrants = (grants: typeof f.base.writer.principal.grants) => f.base.db.pool.query(
        'update management_principals set grants=$2::jsonb where id=$1',
        [f.base.writer.principal.id, JSON.stringify(grants)])
      const fullGrants = f.base.writer.principal.grants
      const narrowedGrants = fullGrants.map(grant => ({ ...grant, actions: grant.actions.filter(action => action !== missing) }))
      const staged = await callEdit(stage)
      expect(await callEdit(stage)).toEqual(staged)
      const intent = staged.intent!
      const advance = { workspaceId: f.workspaceId, workflowId: saveInput.workflowId, draftId: stage.draftId,
        intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }
      const readInput = { action: 'read_edits', workspaceId: f.workspaceId, workflowId: saveInput.workflowId,
        draftId: stage.draftId, intentId: intent.id }
      await setGrants(narrowedGrants)
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: stage }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: advance }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edits_get_v3', arguments: readInput }))
      await setGrants(fullGrants)
      const completed = await callEdit(advance)
      expect(completed.intent?.state).toBe('saved')
      expect(await callEdit(advance)).toEqual(completed)
      const published = completed.intent!.result!
      const discardedStage = { ...stage, commandId: randomUUID(), draftId: randomUUID(),
        expectedRevision: published.revision, expectedWorkflowVersionId: published.currentVersionId,
        graph: { ...published.version.definition, defaultWorktree: {
          rootBinding: f.placement.local.rootBinding!, branchPrefix: 'foreman/discarded',
        } } }
      const discardIntent = (await callEdit(discardedStage)).intent!
      const discard = { workspaceId: f.workspaceId, workflowId: saveInput.workflowId, draftId: discardedStage.draftId,
        intentId: discardIntent.id, action: 'discard_edits', commandId: discardIntent.discardCommandId }
      expect((await callEdit(discard)).intent?.state).toBe('discarded')
      await setGrants(narrowedGrants)
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: stage }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: advance }))
      await expectMcpAccessDenied(f.base.client.callTool({ name: 'workflow_edit_v3', arguments: discard }))
      expect((await f.read(saveInput.workflowId)).version).toEqual(published.version)
    } finally { await f.close() }
  }, 30_000)
})
