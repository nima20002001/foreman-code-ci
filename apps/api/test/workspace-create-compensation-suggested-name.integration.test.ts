import { afterEach, describe, it, vi } from 'vitest'
import { checkWorkspaceCreationCompensation, workspaceCreationFailures } from './helpers/workspaceCreateCompensation.js'

afterEach(() => vi.restoreAllMocks())

describe('workspace project folder compensation through authenticated MCP', () => {
  it.each(workspaceCreationFailures)('removes the suggested folder after a %s failure', async failure => {
    await checkWorkspaceCreationCompensation(failure, { explicitName: false })
  }, 30_000)
})
