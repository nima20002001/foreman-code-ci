import { asRecord } from '../../../shared/records.js'
/** Structured SDK evidence only. These are adapter observations, not admission,
 * response delivery, cancellation, or Foreman Code work-completion receipts. */
export interface ClaudeEventOwner { readonly ownerId: string; readonly attemptId: string; readonly generation: string | number }
export interface ClaudeEventEvidence {
  owner: ClaudeEventOwner
  observedAt: string
  eventId?: string
  nativeSessionId?: string
  messageId?: string
  messageUuid?: string
  contentIndex?: number
  parentToolUseId?: string
  toolUseId?: string
  promptUuids: readonly string[]
}
export interface ClaudeCumulativeModelUsage {
  inputTokens?: number; outputTokens?: number; thinkingTokens?: number
  cacheReadInputTokens?: number; cacheCreationInputTokens?: number; webSearchRequests?: number; costUSD?: number
}
export type ClaudeDecodedChange =
  | { kind: 'session'; model?: string }
  | { kind: 'text'; itemId: string; role?: 'user' | 'assistant'; truncation?: { truncated: boolean; originalBytes: number }; operation: 'append' | 'replace'; text: string; final: boolean }
  | { kind: 'tool'; itemId: string; name?: string; input?: unknown; inputJsonDelta?: string; output?: unknown; status: 'running' | 'completed' | 'failed'; provisional: boolean }
  | { kind: 'task'; taskId: string; status: 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'; taskType?: string; agentId?: string; description?: string; depth?: number; background?: boolean; summary?: string }
  | { kind: 'result'; outcome: 'succeeded' | 'failed' | 'unknown'; subtype: string; text?: string; resultIndex?: number; cumulativeCostUsd?: number
      cumulativeModelUsage?: Record<string, ClaudeCumulativeModelUsage>; terminalReason?: string; deferredToolUse?: boolean }
  | { kind: 'compaction' }
  | { kind: 'diagnostic'; code: string }
export interface ClaudeDecodedEvent { evidence: ClaudeEventEvidence; change: ClaudeDecodedChange }
interface Block {
  itemId: string
  index: number
  type: string
  toolUseId?: string
  name?: string
  text: string
  canonical: boolean
  truncated: boolean
  originalBytes: number
}
const textLimit = 24000
function textPrefix(text: string, limit = textLimit): string {
  const prefix = text.slice(0, limit)
  if (text.length > limit && /[\uD800-\uDBFF]$/.test(prefix)) return prefix.slice(0, -1)
  return prefix
}
function appendText(block: Block, text: string): string {
  block.originalBytes += Buffer.byteLength(text)
  if (block.truncated) return ''
  const retained = textPrefix(text, textLimit - block.text.length)
  block.truncated = retained.length < text.length
  block.text += retained
  return retained
}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length ? value : undefined
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
const cost = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const resultSubtypes = new Set(['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'])
const tokenFields = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'webSearchRequests'] as const
function cumulativeModelUsage(value: unknown): Record<string, ClaudeCumulativeModelUsage> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([model, raw]) => {
    const usage = asRecord(raw)
    return [model, { ...Object.fromEntries(tokenFields.filter((key) => count(usage[key]) !== undefined).map((key) => [key, usage[key]])),
      ...(cost(usage.costUSD) !== undefined ? { costUSD: usage.costUSD as number } : {}) }]
  }))
}

export interface ClaudeEventNormalizer {
  ingest(raw: unknown): ClaudeDecodedEvent[]
  /** EOF/iterator error cannot overwrite an observed result. */
  finish(error?: unknown): ClaudeDecodedEvent[]
  unresolvedTaskIds(): readonly string[]
}

export function createClaudeEventNormalizer(options: { owner: ClaudeEventOwner; observedAt(): string; maxItems?: number }): ClaudeEventNormalizer {
  const owner = { ...options.owner }
  const limit = options.maxItems ?? 2048
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Claude normalizer needs a positive bounded item limit.')
  let sessionId: string | undefined
  let sawResult = false
  let finished = false
  const seen = new Set<string>()
  const streams = new Map<string, { messageId: string; blocks: Map<number, Block> }>()
  const tasks = new Map<string, 'running' | 'completed' | 'failed' | 'canceled' | 'unknown'>()
  const toolNames = new Map<string, string>()
  function rememberTool(id: string | undefined, name: string | undefined) {
    if (!id || !name) return
    if (!toolNames.has(id) && toolNames.size >= limit) toolNames.delete(toolNames.keys().next().value!)
    toolNames.set(id, name)
  }
  const scopeKey = (parent: string | undefined) => parent ?? ''
  function evidence(frame: Record<string, unknown>): ClaudeEventEvidence {
    const parentToolUseId = string(frame.parent_tool_use_id)
    const promptUuids = parentToolUseId ? [] : [...new Set([
      ...(Array.isArray(frame.user_message_uuids) ? frame.user_message_uuids.filter((id): id is string => typeof id === 'string' && Boolean(id)) : []),
      ...(string(frame.user_message_uuid) ? [frame.user_message_uuid as string] : []),
    ])].slice(0, 64)
    return { owner, observedAt: options.observedAt(), promptUuids,
      ...(sessionId ? { nativeSessionId: sessionId } : {}),
      ...(string(frame.uuid) ? { eventId: frame.uuid as string, messageUuid: frame.uuid as string } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}) }
  }
  function diagnostic(base: ClaudeEventEvidence, code: string): ClaudeDecodedEvent[] {
    return [{ evidence: base, change: { kind: 'diagnostic', code } }]
  }
  return {
    ingest(raw) {
      const frame = asRecord(raw)
      const nativeId = string(frame.session_id)
      if (nativeId && sessionId && nativeId !== sessionId) return diagnostic(evidence(frame), 'CLAUDE_SESSION_MISMATCH')
      sessionId ??= nativeId
      const base = evidence(frame)
      if (finished) return diagnostic(base, 'CLAUDE_LATE_EVENT')
      // A frame UUID identifies this SDK emission; message.message.id does not.
      const eventId = string(frame.uuid)
      if (eventId) {
        if (seen.has(eventId)) return []
        if (seen.size >= limit) seen.delete(seen.values().next().value!)
        seen.add(eventId)
      }
      const emit = (change: ClaudeDecodedChange, extra: Partial<ClaudeEventEvidence> = {}): ClaudeDecodedEvent => ({ evidence: { ...base, ...extra }, change })
      if (frame.type === 'system') {
        if (frame.subtype === 'init') return [emit({ kind: 'session', ...(string(frame.model) ? { model: frame.model as string } : {}) })]
        if (frame.subtype === 'compact_boundary') return [emit({ kind: 'compaction' })]
        if (['task_started', 'task_progress', 'task_updated', 'task_notification'].includes(String(frame.subtype))) {
          const taskId = string(frame.task_id)
          if (!taskId) return diagnostic(base, 'CLAUDE_TASK_ID_MISSING')
          if (!tasks.has(taskId) && tasks.size >= limit) return diagnostic(base, 'CLAUDE_TASK_WINDOW_EXCEEDED')
          const patch = asRecord(frame.patch)
          const value = frame.subtype === 'task_notification' ? frame.status : patch.status
          const prior = tasks.get(taskId)
          const status = value === 'completed' ? 'completed' : value === 'failed' ? 'failed'
            : ['stopped', 'killed'].includes(String(value)) ? 'canceled' : frame.subtype === 'task_started' || frame.subtype === 'task_progress' || value === 'running' ? 'running' : 'unknown'
          if (prior === status && ['completed', 'failed', 'canceled'].includes(status)) return []
          if (prior && ['completed', 'failed', 'canceled'].includes(prior) && ['running', 'unknown'].includes(status)) return []
          const retainedStatus = frame.subtype === 'task_updated' && value === undefined ? prior ?? status : status
          tasks.set(taskId, retainedStatus)
          return [emit({ kind: 'task', taskId, status: retainedStatus,
            ...(string(frame.task_type) ? { taskType: frame.task_type as string } : {}),
            ...(string(frame.agent_id) ? { agentId: frame.agent_id as string } : {}),
            ...(string(frame.description) ? { description: (frame.description as string).slice(0, 512) } : {}),
            ...(count(frame.depth) !== undefined ? { depth: frame.depth as number } : {}),
            ...(typeof frame.is_backgrounded === 'boolean' ? { background: frame.is_backgrounded } : typeof patch.is_backgrounded === 'boolean' ? { background: patch.is_backgrounded } : {}),
            ...(string(frame.summary) ? { summary: (frame.summary as string).slice(0, 24000) } : {}) },
          { ...(string(frame.tool_use_id) ? { toolUseId: frame.tool_use_id as string } : {}) })]
        }
        // Informational variants are diagnosed without exposing opaque payloads.
        return diagnostic(base, 'CLAUDE_SYSTEM_VARIANT')
      }
      if (frame.type === 'stream_event') {
        // Current SDK does not promise subagent token deltas.
        if (base.parentToolUseId) return diagnostic(base, 'CLAUDE_CHILD_STREAM_UNQUALIFIED')
        const event = asRecord(frame.event)
        const key = scopeKey(base.parentToolUseId)
        if (event.type === 'message_start') {
          const messageId = string(asRecord(event.message).id)
          if (!messageId) return diagnostic(base, 'CLAUDE_MESSAGE_ID_MISSING')
          streams.set(key, { messageId, blocks: new Map() })
          return []
        }
        const stream = streams.get(key)
        const index = count(event.index)
        if (event.type === 'content_block_start' && stream && index !== undefined) {
          if (stream.blocks.size >= limit) return diagnostic(base, 'CLAUDE_BLOCK_WINDOW_EXCEEDED')
          const content = asRecord(event.content_block)
          const type = String(content.type)
          const toolUseId = string(content.id)
          const name = string(content.name)
          if (type === 'tool_use') rememberTool(toolUseId, name)
          const block: Block = { itemId: type === 'tool_use' && toolUseId ? `claude:tool:${toolUseId}` : `claude:${stream.messageId}:${index}`,
            index, type, text: '', canonical: false, truncated: false, originalBytes: 0, ...(toolUseId ? { toolUseId } : {}), ...(name ? { name } : {}) }
          stream.blocks.set(index, block)
          const extra = { messageId: stream.messageId, contentIndex: index, ...(toolUseId ? { toolUseId } : {}) }
          if (type === 'text') {
            const text = appendText(block, typeof content.text === 'string' ? content.text : '')
            return text || block.truncated ? [emit({ kind: 'text', itemId: block.itemId,
              operation: 'append', text, final: false,
              truncation: { truncated: block.truncated, originalBytes: block.originalBytes } }, extra)] : []
          }
          if (type === 'tool_use') return [emit({ kind: 'tool', itemId: block.itemId, ...(string(content.name) ? { name: content.name as string } : {}), status: 'running', provisional: true }, extra)]
          // Raw thinking/signatures are never public reasoning summaries.
          return ['thinking', 'redacted_thinking'].includes(type) ? [] : diagnostic(base, 'CLAUDE_BLOCK_VARIANT')
        }
        if (event.type === 'content_block_delta' && stream && index !== undefined) {
          const block = stream.blocks.get(index)
          if (!block) return diagnostic(base, 'CLAUDE_BLOCK_START_MISSING')
          if (block.canonical) return []
          const delta = asRecord(event.delta)
          const extra = { messageId: stream.messageId, contentIndex: index, ...(block.toolUseId ? { toolUseId: block.toolUseId } : {}) }
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && block.type === 'text') {
            const text = appendText(block, delta.text)
            return [emit({ kind: 'text', itemId: block.itemId, operation: 'append', text, final: false,
              truncation: { truncated: block.truncated, originalBytes: block.originalBytes } }, extra)]
          }
          if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string' && block.type === 'tool_use') return [emit({ kind: 'tool', itemId: block.itemId, ...(block.name ? { name: block.name } : {}), inputJsonDelta: delta.partial_json.slice(0, 16000), status: 'running', provisional: true }, extra)]
          return ['thinking_delta', 'signature_delta'].includes(String(delta.type)) ? [] : diagnostic(base, 'CLAUDE_DELTA_VARIANT')
        }
        // Neither block_stop nor message_stop is a provider turn result.
        if (['content_block_stop', 'message_delta', 'message_stop', 'ping'].includes(String(event.type))) return []
        return diagnostic(base, 'CLAUDE_STREAM_VARIANT')
      }
      if (frame.type === 'assistant') {
        const message = asRecord(frame.message)
        const messageId = string(message.id)
        if (!eventId || !messageId || !Array.isArray(message.content)) return diagnostic(base, 'CLAUDE_ASSISTANT_ID_MISSING')
        const stream = streams.get(scopeKey(base.parentToolUseId))
        return message.content.flatMap((value, offset): ClaudeDecodedEvent[] => {
          const content = asRecord(value)
          const type = String(content.type)
          const toolUseId = string(content.id)
          if (type === 'tool_use') rememberTool(toolUseId, string(content.name))
          const candidates = stream?.messageId === messageId ? [...stream.blocks.values()].filter((block) => !block.canonical && block.type === type
            && (type !== 'tool_use' || block.toolUseId === toolUseId)) : []
          const block = candidates[0]
          if (block) block.canonical = true
          const itemId = block?.itemId ?? (type === 'tool_use' && toolUseId ? `claude:tool:${toolUseId}` : `claude:${eventId}:${offset}`)
          const extra = { messageId, ...(block ? { contentIndex: block.index } : base.parentToolUseId ? { contentIndex: offset } : {}), ...(toolUseId ? { toolUseId } : {}) }
          if (type === 'text' && typeof content.text === 'string') {
            const text = textPrefix(content.text)
            return [emit({ kind: 'text', itemId, operation: 'replace', text, final: frame.aborted !== true,
              truncation: { truncated: text.length < content.text.length,
                originalBytes: Buffer.byteLength(content.text) } }, extra)]
          }
          if (type === 'tool_use' && toolUseId) return [emit({ kind: 'tool', itemId, ...(string(content.name) ? { name: content.name as string } : {}), input: content.input, status: 'running', provisional: false }, extra)]
          return ['thinking', 'redacted_thinking'].includes(type) ? [] : diagnostic({ ...base, ...extra }, 'CLAUDE_BLOCK_VARIANT')
        })
      }
      if (frame.type === 'user') {
        const message = asRecord(frame.message)
        return (Array.isArray(message.content) ? message.content : typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : []).flatMap((value, index): ClaudeDecodedEvent[] => {
          const content = asRecord(value)
          const toolUseId = string(content.tool_use_id)
          if (base.parentToolUseId && eventId && content.type === 'text' && typeof content.text === 'string') {
            const text = textPrefix(content.text)
            return [emit({ kind: 'text', role: 'user', itemId: `claude:${eventId}:${index}`,
              operation: 'replace', text, final: true,
              truncation: { truncated: text.length < content.text.length, originalBytes: Buffer.byteLength(content.text) },
            }, { messageId: string(message.id) ?? eventId, contentIndex: index })]
          }
          if (content.type !== 'tool_result' || !toolUseId) return []
          return [emit({ kind: 'tool', itemId: `claude:tool:${toolUseId}`, output: content.content,
            ...(toolNames.get(toolUseId) ? { name: toolNames.get(toolUseId)! } : {}),
            status: content.is_error === true ? 'failed' : 'completed', provisional: false }, { toolUseId })]
        })
      }
      if (frame.type === 'result') {
        const subtype = string(frame.subtype) ?? 'unknown'
        if (!resultSubtypes.has(subtype) || !eventId || !sessionId || typeof frame.is_error !== 'boolean') return diagnostic(base, 'CLAUDE_RESULT_VARIANT')
        sawResult = true
        const outcome = subtype === 'success' && frame.is_error === false ? 'succeeded' : 'failed'
        const modelUsage = cumulativeModelUsage(frame.modelUsage)
        return [emit({ kind: 'result', outcome, subtype,
          ...(typeof frame.result === 'string' ? { text: frame.result } : {}),
          ...(count(frame.result_index) !== undefined ? { resultIndex: frame.result_index as number } : {}),
          ...(cost(frame.total_cost_usd) !== undefined ? { cumulativeCostUsd: frame.total_cost_usd as number } : {}),
          ...(modelUsage ? { cumulativeModelUsage: modelUsage } : {}),
          ...(string(frame.terminal_reason) ? { terminalReason: frame.terminal_reason as string } : {}),
          ...(frame.deferred_tool_use && typeof frame.deferred_tool_use === 'object' ? { deferredToolUse: true } : {}) })]
      }
      return diagnostic(base, 'CLAUDE_UNKNOWN_VARIANT')
    },
    finish(error) {
      if (finished) return []
      finished = true
      const base = evidence({})
      return diagnostic(base, sawResult ? error === undefined ? 'CLAUDE_STREAM_ENDED_AFTER_RESULT' : 'CLAUDE_STREAM_ERROR_AFTER_RESULT'
        : error === undefined ? 'CLAUDE_EOF_WITHOUT_RESULT' : 'CLAUDE_STREAM_ERROR_WITHOUT_RESULT')
    },
    unresolvedTaskIds: () => [...tasks].filter(([, status]) => !['completed', 'failed', 'canceled'].includes(status)).map(([id]) => id),
  }
}
