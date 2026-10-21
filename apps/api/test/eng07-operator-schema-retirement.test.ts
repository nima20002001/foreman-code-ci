import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, it, vi } from 'vitest'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveInputSchema, CurrentWorkflowReadResultSchema,
  ManualRunStartInputSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { registerCurrentWorkflowTools } from '../src/mcp/operator/tools/currentWorkflow.js'
import { runTools } from '../src/mcp/operator/tools/runs.js'
import { registerOperatorToolGroup } from '../src/mcp/operator/server.js'
import { retiredExecutionToolCall } from '../src/mcp/operator/retiredExecutionTools.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'

// Registration/schema tests only. Authentication, scoped grants and denial audit
// integration are not replaced by these visibility stubs.
vi.mock('../src/modules/workflows/currentWorkflowPolicy.js', () => ({ currentWorkflowAvailable: () => true }))
vi.mock('../src/mcp/operator/definition.js', async (original) => ({
  ...await original<typeof import('../src/mcp/operator/definition.js')>(), toolAvailable: () => true,
}))

function tools() {
  const declarations = new Map<string, { description: string; inputSchema: unknown; outputSchema: unknown }>()
  const server = { registerTool: (name: string, declaration: { description: string; inputSchema: unknown; outputSchema: unknown }) => {
    declarations.set(name, declaration)
  } } as unknown as McpServer
  const recordAudit = vi.fn(async () => undefined)
  const start = vi.fn(), save = vi.fn(), read = vi.fn()
  const context = { principal: { id: 'retirement-principal' }, services: {
    workflows: { current: { save, read } }, runs: { start }, commands: { recordAudit },
  } } as unknown as OperatorRequestContext
  registerCurrentWorkflowTools(server, context)
  registerOperatorToolGroup(server, context, runTools)
  return { declarations, context, recordAudit, start, save, read }
}

describe('ENG07 Operator schemas and retirement denial', () => {
  it('advertises the same canonical V3 Save/read/Start objects used by HTTP clients', () => {
    const { declarations } = tools()
    expect(declarations.get(CURRENT_WORKFLOW_TOOLS.save)?.inputSchema).toBe(CurrentWorkflowSaveInputSchema)
    expect(declarations.get(CURRENT_WORKFLOW_TOOLS.saved)?.outputSchema).toBe(CurrentWorkflowReadResultSchema)
    expect(declarations.get('run_start')?.inputSchema).toBe(ManualRunStartInputSchema)
    expect(declarations.has('run_current_get_v1')).toBe(false)
    expect(declarations.has('run_history_get_v1')).toBe(false)
    expect(declarations.get(CURRENT_WORKFLOW_TOOLS.save)?.description).toContain('Unsettled Runs or unresolved staged edits block executable changes')
    expect(declarations.get(CURRENT_WORKFLOW_TOOLS.edits)?.description).toContain('only after every exact affected Run is genuinely settled')
  })

  it.each(['run_current_get_v1', 'run_history_get_v1'])('audits and denies %s without invoking a current service', async (name) => {
    const { context, recordAudit, start, save, read } = tools()
    const { scope } = makeCurrentWorkflowFixture('retired-mcp')
    const result = await retiredExecutionToolCall(context, {
      jsonrpc: '2.0', id: 'retired-command', method: 'tools/call', params: { name, arguments: scope },
    })
    expect(result).toMatchObject({ jsonrpc: '2.0', id: 'retired-command', result: { isError: true } })
    expect(JSON.stringify(result)).toContain('EXECUTION_SEMANTICS_UNSUPPORTED')
    expect(recordAudit).toHaveBeenCalledWith('retirement-principal', 'mcp', name, `mcp:${name}`, 'failed',
      { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
    expect(start).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })
})
