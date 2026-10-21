import { expect, it } from 'vitest'
import { decodeRunHistoryCursor, encodeRunHistoryCursor } from '../src/modules/runs/historyCursor.js'

it('keeps microseconds and binds workspace-wide cursors to the optional workflow filter', () => {
  const workspace = { workspaceId: 'workspace-a' }
  const workflow = { ...workspace, workflowId: 'workflow-a' }
  const boundary = { admittedAt: '2030-01-01T00:00:00.123456Z', runId: 'run-a' }
  const workspaceCursor = encodeRunHistoryCursor(workspace, boundary)
  const workflowCursor = encodeRunHistoryCursor(workflow, boundary)
  expect(decodeRunHistoryCursor(workspace, workspaceCursor)).toEqual(boundary)
  expect(decodeRunHistoryCursor(workflow, workflowCursor)).toEqual(boundary)
  expect(workspaceCursor).not.toBe(workflowCursor)
  for (const scope of [{ workspaceId: 'workspace-b' }, workflow]) {
    expect(() => decodeRunHistoryCursor(scope, workspaceCursor)).toThrowError(
      expect.objectContaining({ code: 'RUN_HISTORY_CURSOR_INVALID', status: 400 }),
    )
  }
  for (const cursor of [workflowCursor, boundary.runId]) {
    expect(() => decodeRunHistoryCursor(workspace, cursor)).toThrowError(
      expect.objectContaining({ code: 'RUN_HISTORY_CURSOR_INVALID', status: 400 }),
    )
  }
})
