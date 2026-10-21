import { expect, it } from 'vitest'

it('publishes Run-owned chat tools as one discoverable object envelope with exact-arm validation', async () => {
  const { agentChatTools } = await import('./tools/agentChat.js')
  const { withWorkflowExecutionChatTools } = await import('./executionChat.js')
  const tools = withWorkflowExecutionChatTools(agentChatTools)
  const tool = (name: string) => tools.find(entry => entry.name === name)!
  for (const name of ['agent_chat_read', 'agent_chat_send', 'agent_chat_interrupt', 'agent_chat_cancel_queued', 'agent_chat_cancel_all_queued']) {
    const input = tool(name).inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
    expect(input.type, name).toBe('object')
    expect(input.properties, name).toHaveProperty('target')
    const output = tool(name).outputSchema?.['~standard'].jsonSchema.output({ target: 'draft-2020-12' })
    expect(output?.type, name).toBe('object')
  }
  const read = tool('agent_chat_read')
  expect(Object.keys(read.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }).properties as object))
    .toEqual(expect.arrayContaining(['workspaceId', 'query', 'selection', 'history', 'resolve', 'messageId']))
  const validate = async (value: unknown) => (await read.inputSchema['~standard'].validate(value)).issues
  expect(await validate({ resolve: { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node-a' } })).toBeUndefined()
  expect(await validate({ workspaceId: 'workspace' })).toBeDefined()
})
