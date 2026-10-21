import { describe, expect, it } from 'vitest'
import {
  ManagedPromptSettingSchema,
  MAX_PROMPT_TEXT_LENGTH,
  OperatorToolNameSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
} from '../src/management/index.js'
import { PromptSettingSnapshotSchema } from '../src/index.js'

describe('prompt settings contracts', () => {
  it('preserves multiline text and explicitly empty prompts', () => {
    for (const text of ['', '  Keep spaces.\nUse فارسی and 日本語.\n']) {
      const input = { value: { text }, expectedRevision: 0, commandId: 'save-prompt-command' }
      expect(PromptSettingUpdateInputSchema.parse(input)).toEqual(input)
      const snapshot = { value: { text }, revision: 1, versionId: 'prompt-version-1' }
      expect(ManagedPromptSettingSchema.parse(snapshot)).toEqual(snapshot)
      expect(PromptSettingSnapshotSchema.parse(snapshot)).toEqual(snapshot)
      expect(PromptSettingUpdateResultSchema.parse({ value: snapshot, replayed: false }))
        .toEqual({ value: snapshot, replayed: false })
    }
  })

  it('rejects invalid revisions, command IDs, text types, and unexpected fields', () => {
    const valid = { value: { text: 'Use careful reasoning.' }, expectedRevision: 0, commandId: 'save-prompt-command' }
    for (const input of [
      { ...valid, expectedRevision: -1 },
      { ...valid, expectedRevision: 1.5 },
      { ...valid, commandId: 'short' },
      { ...valid, value: { text: false } },
      { ...valid, value: { text: 'Prompt', grants: ['settings:update'] } },
      { ...valid, agentId: 'operator' },
    ]) {
      expect(PromptSettingUpdateInputSchema.safeParse(input).success).toBe(false)
    }
  })

  it('accepts the prompt length limit without truncation and rejects longer text', () => {
    const text = 'x'.repeat(MAX_PROMPT_TEXT_LENGTH)
    const input = { value: { text }, expectedRevision: 0, commandId: 'save-prompt-command' }
    expect(PromptSettingUpdateInputSchema.parse(input).value.text).toBe(text)
    expect(PromptSettingUpdateInputSchema.safeParse({ ...input, value: { text: `${text}x` } }).success)
      .toBe(false)
    expect(PromptSettingSnapshotSchema.safeParse({
      value: { text: `${text}x` }, revision: 1, versionId: 'prompt-version-1',
    }).success).toBe(false)
  })

  it('names read and update tools for both settings', () => {
    for (const name of [
      'system_prompt_get',
      'system_prompt_update',
      'operator_initial_prompt_get',
      'operator_initial_prompt_update',
    ]) {
      expect(OperatorToolNameSchema.parse(name)).toBe(name)
    }
  })
})
