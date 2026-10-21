import { asRecord } from '../../shared/records.js'
import { claudeConversationActivity } from '../harnesses/claudeSdk/conversationActivity.js'
import { codexUnsupportedInteractionMessage,
  type RecordedAgentHarness, type NativeHarnessEvent, type OperatorActivity } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'

export type OperatorActivityChange = Omit<OperatorActivity, 'sequence' | 'revision'>
const string = (value: unknown) => typeof value === 'string' ? value : ''
const pretty = (value: unknown): string => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2)
function status(value: unknown, completed: boolean): OperatorActivity['status'] {
  if (['failed', 'error', 'declined'].includes(String(value))) return 'failed'
  if (['canceled', 'cancelled', 'interrupted'].includes(String(value))) return 'canceled'
  if (['completed', 'success'].includes(String(value))) return 'completed'
  if (value === 'pending') return 'pending'
  if (['inProgress', 'running'].includes(String(value))) return 'running'
  return completed ? 'completed' : 'running'
}
function bounded(value: OperatorActivityChange): OperatorActivityChange {
  const truncated = (value.input?.length ?? 0) > 16000 || (value.output?.length ?? 0) > 24000
  return { ...value, title: value.title.slice(0, 240),
    ...(value.input !== undefined ? { input: value.input.slice(0, 16000) } : {}),
    ...(value.output !== undefined ? { output: value.output.slice(0, 24000) } : {}),
    ...(truncated ? { truncated: true } : {}) }
}
const collabNames: Record<string, string> = {
  spawnAgent: 'Start subagent', sendInput: 'Message subagent', sendMessage: 'Message subagent',
  resumeAgent: 'Resume subagent', followupTask: 'Give subagent a task', wait: 'Wait for subagent',
  closeAgent: 'Close subagent', interruptAgent: 'Stop subagent', listAgents: 'List subagents',
}

/** Classify only structured native evidence. Opaque shell scripts remain commands. */
export function operatorActivity(event: NativeHarnessEvent, harness: RecordedAgentHarness, requestId: string): OperatorActivityChange | undefined {
  if (harness === 'opencode') return undefined
  if (event.type === 'session.compaction' || event.type === 'session.compacted') {
    const id = string(event.payload.nativeOperationId) || string(event.payload.nativeEventId)
      || `${harness}-compaction-${event.connectionId ?? 'session'}-${event.sequence}`
    let title = 'Context compacted'
    let status: OperatorActivity['status'] = 'completed'
    let output = 'Native compaction boundary observed. Waiting for updated context usage.'
    if (event.payload.status === 'failed') {
      title = 'Compaction failed'
      status = 'failed'
      output = 'The native provider did not finish compaction.'
    } else if (event.payload.status === 'uncertain' || event.payload.status === 'running' || event.payload.status === 'accepted') {
      title = 'Compaction unconfirmed'
      status = 'running'
      output = 'Read this conversation to recover compaction.'
    } else if (event.payload.status === 'no-op') {
      title = 'Context unchanged'
      output = 'The native session had nothing to compact.'
    }
    return bounded({ id, requestId, kind: 'tool', title, status, output })
  }
  if (harness === 'claude') return claudeConversationActivity(event, requestId)
  const payload = event.payload
  if (harness === 'codex' && event.type === 'interaction.unsupported') {
    const message = codexUnsupportedInteractionMessage(payload.code)
    const id = string(payload.activityId)
    if (!message || !id || !string(payload.turnId)) return
    return bounded({ id, requestId, kind: 'tool', status: 'failed', title: message, output: message })
  }
  if (harness === 'codex' && ['item.started', 'item.completed', 'item.snapshot'].includes(event.type)) {
    const item = asRecord(payload.item)
    const id = string(item.id)
    if (!id) return
    const base = { id, requestId, status: status(item.status, event.type === 'item.completed' || payload.nativeTurnStatus === 'completed') }
    switch (item.type) {
      case 'contextCompaction': return bounded({ ...base, kind: 'tool', title: 'Compact context' })
      case 'reasoning': {
        // Only the provider's public summary, never encrypted or raw reasoning content.
        const summary = Array.isArray(item.summary) ? item.summary.filter((value): value is string => typeof value === 'string').join('\n\n') : ''
        return bounded({ ...base, kind: 'thinking', title: 'Thinking', ...(summary ? { output: summary } : {}) })
      }
      case 'commandExecution': {
        const actions = Array.isArray(item.commandActions) ? item.commandActions.map(asRecord) : []
        const read = actions.find((action) => ['read', 'listFiles', 'search'].includes(String(action.type)))
        const title = read?.type === 'read' ? `Read ${string(read.name) || string(read.path) || 'file'}`
          : read?.type === 'search' ? 'Search files' : read?.type === 'listFiles' ? 'List files' : 'Run command'
        return bounded({ ...base, kind: read ? 'file_read' : 'tool', title,
          input: pretty({ command: item.command, cwd: item.cwd }),
          ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}) })
      }
      case 'fileChange': return bounded({ ...base, kind: 'file_write', title: 'Change files', input: pretty(item.changes) })
      case 'mcpToolCall': return bounded({ ...base, kind: 'mcp', title: `${string(item.server)} · ${string(item.tool)}`,
        status: item.error ? 'failed' : base.status, input: pretty(item.arguments), ...(item.error != null || item.result != null ? { output: pretty(item.error ?? item.result) } : {}) })
      case 'webSearch': {
        const action = asRecord(item.action)
        return bounded({ ...base, kind: 'web_search', title: action.type === 'openPage' ? 'Open webpage' : action.type === 'findInPage' ? 'Find in webpage' : 'Search the web',
          input: pretty(item.action ?? item.query), ...(item.results != null ? { output: pretty(item.results) } : {}) })
      }
      case 'collabAgentToolCall': return bounded({ ...base, kind: 'subagent', title: collabNames[string(item.tool)] ?? 'Subagent activity',
        input: pretty({ prompt: item.prompt, model: item.model, effort: item.reasoningEffort, agents: item.receiverThreadIds }), output: pretty(item.agentsStates) })
      case 'dynamicToolCall': return bounded({ ...base, kind: 'tool', title: string(item.tool) || 'Use tool',
        status: item.success === false ? 'failed' : base.status, input: pretty(item.arguments), ...(item.contentItems != null ? { output: pretty(item.contentItems) } : {}) })
      default: return
    }
  }
  return undefined
}

/** A resumed session can contain older turns. Never relabel their activity as this request. */
export function currentOperatorHistory(history: NativeHistory, harness: RecordedAgentHarness): NativeHarnessEvent[] {
  if (harness === 'claude') {
    const receipt = history.nativeSubmission
    if (receipt?.kind !== 'message' || history.correlationId !== receipt.clientCorrelationId) return []
    return history.events.filter(event => event.payload.clientCorrelationId === receipt.clientCorrelationId
      && event.payload.nativeSessionId === receipt.nativeSessionId && !event.payload.parentToolUseId
      && !event.payload.subagentNativeId)
  }
  if (!history.nativeTurnId) return []
  if (harness === 'codex') return history.events.filter((event) => event.payload.turnId === history.nativeTurnId)
  return []
}
