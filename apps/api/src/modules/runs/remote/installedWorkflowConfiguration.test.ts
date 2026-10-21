import { describe, expect, it } from 'vitest'
import { InstalledWorkflowConfigurationSchema, installedHarnessSelection } from './installedWorkflowConfiguration.js'

const codex = {
  schemaVersion: 1,
  codexBinary: '/installed/codex',
  expectedVersion: '0.154.0',
  payloadPaths: [],
  appMcpLauncher: '/installed/app-mcp.mjs',
}

describe('installed workflow harness selection', () => {
  it('keeps the configured Codex binary and payload selection', () => {
    const configuration = InstalledWorkflowConfigurationSchema.parse(codex)
    expect(installedHarnessSelection(configuration)).toEqual({
      binary: codex.codexBinary,
      expectedVersion: codex.expectedVersion,
      payloadPaths: [],
    })
  })

  it('accepts a Claude-only selection without manufacturing a Codex selection', () => {
    const configuration = InstalledWorkflowConfigurationSchema.parse({
      schemaVersion: 1,
      appMcpLauncher: '/installed/app-mcp.mjs',
      claude: { binary: '/installed/claude', installedLockPath: '/installed/claude-sdk-lock.json' },
    })
    expect(installedHarnessSelection(configuration)).toBeNull()
  })

  it('rejects an OpenCode selection even when a supported harness is also configured', () => {
    expect(InstalledWorkflowConfigurationSchema.safeParse({
      ...codex,
      opencode: { binary: '/installed/opencode', expectedVersion: '1.18.31', payloadPaths: [] },
    }).success).toBe(false)
  })
})
