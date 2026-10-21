import { afterEach, describe, it, vi } from 'vitest'
import { checkWorkspaceCreationCompensation, workspaceCreationFailures } from './helpers/workspaceCreateCompensation.js'

afterEach(() => vi.restoreAllMocks())

describe('workspace project folder compensation through authenticated MCP', () => {
  it.each(workspaceCreationFailures)('removes the explicit folder after a %s failure', async failure => {
    await checkWorkspaceCreationCompensation(failure, { explicitName: true })
  }, 30_000)
})
