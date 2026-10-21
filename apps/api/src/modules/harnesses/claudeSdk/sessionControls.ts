import type { ContextSnapshot, SessionPreferences } from '@foreman-code/contracts'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'

export class ClaudePreferenceError extends HarnessExecutionError {
  readonly certainty = 'definite'
  readonly deliveryState = 'not-delivered'
}

export function claudeSessionEnvironment(source: NodeJS.ProcessEnv, raw: SessionPreferences): NodeJS.ProcessEnv {
  const preferences = SessionPreferencesSchema.parse(raw)
  const env = { ...source }
  delete env.DISABLE_AUTO_COMPACT
  delete env.DISABLE_COMPACT
  delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (preferences.autoCompact === 'off') env.DISABLE_AUTO_COMPACT = '1'
  if (preferences.autoCompactTokens !== null) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(preferences.autoCompactTokens)
  if (preferences.contextBudget !== null) {
    throw new HarnessExecutionError('CLAUDE_CONTEXT_UNSUPPORTED', 'Claude context size is selected through its native model profile.')
  }
  return env
}

export function claudeContextSnapshot(frame: Record<string, unknown>, sessionId: string, model: string,
  sequence: number): ContextSnapshot | null {
  if (frame.session_id !== sessionId || frame.type !== 'assistant') return null
  const message = frame.message as { usage?: Record<string, unknown> } | undefined
  const usage = message?.usage
  if (!usage || typeof usage.input_tokens !== 'number') return null
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0
  const cacheCreated = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  return { nativeSessionId: sessionId, model, sequence, observedAt: new Date().toISOString(), source: 'claude',
    generation: 'native', accuracy: 'estimated', usedTokens: usage.input_tokens + cacheRead + cacheCreated + output,
    capacityTokens: null, lifetimeTokens: null, cost: null, stale: false }
}


export function claudeContextProfiles(models: readonly { value: string; resolvedModel?: string | undefined }[],
  selectedModel: string, capacity: number | null) {
  const base = (model: string) => model.replace(/\[(?:1m|200k)\]$/, '')
  const selected = models.find(model => model.value === selectedModel || model.resolvedModel === selectedModel)
  const canonical = base(selected?.resolvedModel ?? selectedModel)
  return models.filter(model => base(model.resolvedModel ?? model.value) === canonical
    || selected && base(model.value) === base(selected.value)).flatMap(model => {
    const window = model.value.endsWith('[1m]') ? 1000000
      : model.value.endsWith('[200k]') ? 200000 : model.value === selected?.value ? capacity : null
    return window === null ? [] : [{ id: model.value, label: `${window.toLocaleString()} tokens`, capacity: window }]
  })
}
