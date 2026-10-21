import { expect, it, vi } from 'vitest'
import { codexMcpInspectorAdapter } from './codexMcpInspectorAdapter.js'

it('rejects a different harness before inspecting Codex configuration', async () => {
  const inspectMcpConfiguration = vi.fn()
  const inspector = codexMcpInspectorAdapter({ inspectMcpConfiguration })
  await expect(inspector.inspect({ harness: 'claude', runnerId: 'runner', workingDirectory: '/workspace',
    serverName: 'foreman-code' }))
    .rejects.toMatchObject({ code: 'HARNESS_CONFIGURATION_MISMATCH' })
  expect(inspectMcpConfiguration).not.toHaveBeenCalled()
})
