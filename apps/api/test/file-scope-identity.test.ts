import { expect, it } from 'vitest'
import { fileScopeIdentity } from '../src/modules/files/requests.js'

it('keeps canonical job scope identity stable while separating distinct workspaces, executions and scope kinds', () => {
  const identity = fileScopeIdentity({ kind: 'job_execution', workspaceId: 'workspace', jobExecutionId: 'job-execution' })
  expect(fileScopeIdentity({ jobExecutionId: 'job-execution', workspaceId: 'workspace', kind: 'job_execution' })).toBe(identity)
  expect(fileScopeIdentity({ kind: 'job_execution', workspaceId: 'other-workspace', jobExecutionId: 'job-execution' })).not.toBe(identity)
  expect(fileScopeIdentity({ kind: 'job_execution', workspaceId: 'workspace', jobExecutionId: 'other-execution' })).not.toBe(identity)
  expect(fileScopeIdentity({ kind: 'workspace_reference', workspaceId: 'workspace' })).not.toBe(identity)
})
