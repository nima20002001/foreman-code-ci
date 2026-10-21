import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedPromptSettingSchema, PromptSettingUpdateResultSchema } from '@foreman-code/contracts/management'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'

import { reviewAuthMcpDatabase } from './helpers/reviewAuthMcpDatabase.js'

it('ignores extra authenticated MCP arguments before persistence and retries without granting writes', async () => {
  const database = await reviewAuthMcpDatabase({ hostProfiles: false })
  try {
    const expiresAt = new Date(Date.now() + 120_000)
    const owner = await database.access.issue({ name: 'Prompt editor', audience: 'operator', expiresAt,
      grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }] })
    const reader = await database.access.issue({ name: 'Prompt reader', audience: 'operator', expiresAt,
      grants: [{ actions: ['settings:read'], scope: {} }] })
    const editor = await database.connect(owner.token)
    const readonly = await database.connect(reader.token)
    const initial = await database.repository.getSystemPrompt()
    const input = {
      commandId: randomUUID(), expectedRevision: initial.revision,
      value: { text: 'Stored prompt', explanation: 'ignored' }, explanation: 'ignored',
    }
    const saved = PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(await editor.callTool({
      name: 'system_prompt_update', arguments: input,
    })))
    expect(saved).toMatchObject({ value: { value: { text: 'Stored prompt' }, revision: initial.revision + 1 }, replayed: false })
    const replay = await editor.callTool({ name: 'system_prompt_update', arguments: {
      ...input, value: { text: 'Stored prompt', explanation: 'different extra' }, explanation: 'different extra',
    } })
    expect(PromptSettingUpdateResultSchema.parse(decodeMcpToolResult(replay))).toEqual({ ...saved, replayed: true })
    const readback = await readonly.callTool({ name: 'system_prompt_get', arguments: { explanation: 'ignored' } })
    expect(ManagedPromptSettingSchema.parse(decodeMcpToolResult(readback))).toEqual(saved.value)
    expect(await database.repository.getSystemPrompt()).toEqual(saved.value)
    const detail = decodeMcpToolResult(await editor.callTool({ name: 'operator_tool_schema_get', arguments: {
      name: 'system_prompt_update', explanation: 'ignored',
    } })) as { inputSchema: { additionalProperties?: boolean }; description: string }
    expect(detail.inputSchema.additionalProperties).not.toBe(false)
    expect(detail.description).toContain('Unknown input fields are ignored')
    const invalid = await editor.callTool({ name: 'system_prompt_update', arguments: {
      ...input, commandId: randomUUID(), expectedRevision: -1,
    } })
    expect(invalid.isError).toBe(true)
    const denied = await readonly.callTool({ name: 'system_prompt_update', arguments: {
      ...input, commandId: randomUUID(), expectedRevision: saved.value.revision,
      grants: [{ actions: ['settings:update'], scope: {} }],
    } })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await database.repository.getSystemPrompt()).toEqual(saved.value)
  } finally {
    await database.close()
  }
}, 30_000)
