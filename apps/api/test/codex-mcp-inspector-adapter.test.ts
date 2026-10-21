import { describe, expect, it } from 'vitest'

import { codexMcpInspectorAdapter } from '../src/modules/harnesses/codexMcpInspectorAdapter.js'

describe('Codex HAP-02 MCP inspection adapter', () => {
  it('normalizes the structured effective configuration without starting a runtime', async () => {
    const calls: string[] = []
    const inspector = codexMcpInspectorAdapter({
      inspectMcpConfiguration: async (cwd) => {
        calls.push(cwd)
        return {
          providerVersion: '0.154.0', cwd, serverName: 'graphql',
          binary: 'codex', inspectionScope: 'effective_config' as const,
          configured: {
            enabled: true, transport: 'streamable_http', url: 'http://127.0.0.1:3000/mcp',
            required: false,
            bearerTokenEnvironmentVariable: 'GRAPHQL_MCP_TOKEN',
            enabledTools: ['context_get'], disabledTools: ['interaction_respond'],
            defaultToolsApprovalMode: null, tools: {},
          },
        }
      },
    })
    await expect(inspector.inspect({
      harness: 'codex', runnerId: 'runner-local', workingDirectory: '/workspace', serverName: 'graphql',
    })).resolves.toMatchObject({
      providerVersion: '0.154.0', workingDirectory: '/workspace',
      entry: { transport: 'streamable-http', status: 'status_unavailable' },
    })
    expect(calls).toEqual(['/workspace'])
  })

  it('distinguishes a successful absent-entry result from inspection failure', async () => {
    const inspector = codexMcpInspectorAdapter({
      inspectMcpConfiguration: async () => {
        throw Object.assign(new Error('missing'), {
          result: { outcome: 'failed', error: { code: 'CODEX_MCP_NOT_CONFIGURED', message: 'missing', retryable: false } },
        })
      },
    })
    await expect(inspector.inspect({
      harness: 'codex', runnerId: 'runner-local', workingDirectory: '/workspace', serverName: 'graphql',
    })).resolves.not.toHaveProperty('entry')
  })
})
