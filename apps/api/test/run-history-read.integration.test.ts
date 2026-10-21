import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readCurrentRunDetails } from '../src/modules/runs/currentRead.js'
import { currentRunHistory } from './helpers/currentRunHistory.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.skipIf(!postgresEnabled)('persisted current Run history pins', () => {
  let f: Awaited<ReturnType<typeof currentRunHistory>>
  beforeAll(async () => { f = await currentRunHistory() })
  afterAll(async () => { await f?.db.close() })
  it('reads the accepted V3 version after a newer workflow version is published', async () => {
      const history = await readCurrentRunDetails(f.db.pool, f.owner.principal, f.run.workspaceId, f.run.id)
      expect(history.run.workflowVersionId).toBe(f.saved.value.currentVersionId)
      expect(history.run.workflowVersionId).not.toBe(f.newer.value.currentVersionId)
      expect(history.run.agentConfigurationVersionIds).toEqual(f.saved.value.version.agentConfigurationVersionIds)
      expect(history.run.executionSemanticsVersion).toBe(3)
      expect(history.run).not.toHaveProperty('authorizationPrincipalId')
      expect(history.executions).toEqual([])
      const exact = await f.workflows.current.read(f.owner.principal, { workspaceId: f.run.workspaceId,
        workflowId: f.run.workflowId, workflowVersionId: history.run.workflowVersionId })
      expect(exact.version).toEqual(f.saved.value.version)
      expect(exact.currentVersionId).toBe(f.newer.value.currentVersionId)
  })
})
