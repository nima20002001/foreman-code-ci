import { describe, expect, it } from 'vitest'

import { buildHarnessPrompt } from '../src/modules/harnesses/prompt.js'
import { runJsonlProcess } from '../src/modules/harnesses/process.js'

describe('native harness process boundary', () => {
  it('injects only an Agent-owned App token after preflight without changing parent env or argv', async () => {
    const previous = process.env.GRAPHQL_MCP_TOKEN
    delete process.env.GRAPHQL_MCP_TOKEN
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const controller = new AbortController()
    try {
      const result = await runJsonlProcess({
        binary: process.execPath,
        args: ['-e', 'console.log(JSON.stringify({type:"proof", present:Boolean(process.env.GRAPHQL_MCP_TOKEN), argv:process.argv}))'],
        cwd: process.cwd(),
        signal: controller.signal,
        expectedAgentId: 'agent-a',
        beforeSpawn: async () => ({ agentId: 'agent-a', variables: { GRAPHQL_MCP_TOKEN: 'secret-fixture' } }),
        onSpawn: () => undefined,
        onEvent: async (event) => { events.push(event) },
      })
      expect(result.exitCode).toBe(0)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: 'proof', payload: { type: 'proof', present: true } })
      expect((events[0]?.payload.argv as string[]).join(' ')).not.toContain('secret-fixture')
      expect(JSON.stringify(events)).not.toContain('secret-fixture')
      expect(process.env.GRAPHQL_MCP_TOKEN).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.GRAPHQL_MCP_TOKEN
      else process.env.GRAPHQL_MCP_TOKEN = previous
    }
  })

  it('rejects cross-Agent and arbitrary child environment injection', async () => {
    const controller = new AbortController()
    const base = {
      binary: process.execPath, args: ['-e', ''], cwd: process.cwd(), signal: controller.signal,
      expectedAgentId: 'agent-a', onSpawn: () => undefined, onEvent: async () => undefined,
    }
    await expect(runJsonlProcess({ ...base,
      beforeSpawn: async () => ({ agentId: 'agent-b', variables: { GRAPHQL_MCP_TOKEN: 'secret' } }),
    })).rejects.toThrow('another Agent')
    await expect(runJsonlProcess({ ...base,
      beforeSpawn: async () => ({ agentId: 'agent-a', variables: { DATABASE_URL: 'secret' } }),
    })).rejects.toThrow('Only the scoped Foreman Code MCP credential')
  })

  it('preserves structured and malformed process output as ordered events', async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    const controller = new AbortController()
    const result = await runJsonlProcess({
      binary: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({type:"ready",sessionID:"session-1"})); console.log("plain output")'],
      cwd: process.cwd(),
      signal: controller.signal,
      onSpawn: () => undefined,
      onEvent: async (event) => { events.push(event) },
    })
    expect(result.exitCode).toBe(0)
    expect(events).toEqual([
      { type: 'ready', payload: { type: 'ready', sessionID: 'session-1' } },
      { type: 'unparsed_stdout', payload: { text: 'plain output' } },
    ])
  })

  it('places the accepted workflow input directly into the startup prompt', () => {
    const prompt = buildHarnessPrompt({
      executionId: 'execution-1',
      runId: 'run-1',
      workspaceId: 'workspace-1',
      workflowNodeId: 'node-b',
      workingDirectory: '/tmp/graphql-run',
      runtimeDirectory: '/tmp/graphql-runtime',
      initialPrompt: 'Write a direct answer for the operator.',
      configuration: {
        id: 'config-b',
        workspaceId: 'workspace-1',
        agentId: 'agent-b',
        version: 1,
        prompt: { system: 'Summarize only the supplied facts.' },
        assignedSkills: [],
        harness: {
          harness: 'codex',
          model: 'test-model',
          reasoningEffort: 'high',
          sandbox: 'read-only',
          serviceTier: 'standard',
        },
        contentHash: 'sha256:test',
        createdAt: '2026-09-14T00:00:00.000Z',
      },
      input: { previous: { result: { text: 'Exact stored result' } } },
    })
    expect(prompt).toContain('Summarize only the supplied facts.')
    expect(prompt).toContain('INITIAL USER PROMPT\nWrite a direct answer for the operator.')
    expect(prompt).toContain('"text":"Exact stored result"')
    expect(prompt).toContain('Treat the accepted input above as authoritative.')
  })
})
