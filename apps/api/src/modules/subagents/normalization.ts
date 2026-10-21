import { asRecord } from '../../shared/records.js'
import type { HarnessNativeEvent } from '@foreman-code/contracts'
import type { RunSubagent, RunSubagentTool } from '@foreman-code/contracts/subagents'
import { SUBAGENT_LIMITS, SubagentTruncationSchema } from '@foreman-code/contracts/subagents'
import type { SubagentChange, SubagentProjectionContext } from './types.js'

const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined
const secretKey = /(?:^(?:authorization|cookie|set-cookie|password|passwd|secret|token|access_?token|refresh_?token|api[_-]?key|credential|reasoning|thinking|signature)$|[_-](?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)$)/i
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 16) return '[depth limit]'
  if (Array.isArray(value)) return value.slice(0, 1000).map(item => sanitize(item, depth + 1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 1000)
    .map(([key, item]) => [key, secretKey.test(key) ? '[redacted]' : sanitize(item, depth + 1)]))
  if (typeof value === 'string') return value.replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{8,})/g, '[redacted]')
  return value ?? null
}
export function sanitizeSubagentValue(input: unknown) {
  const originalBytes = Buffer.byteLength(JSON.stringify(input ?? null))
  const sanitized = sanitize(input)
  const serialized = JSON.stringify(sanitized)
  const truncated = originalBytes > SUBAGENT_LIMITS.toolBytes || Buffer.byteLength(serialized) > SUBAGENT_LIMITS.toolBytes
  return { value: truncated ? '[truncated: use provider-owned history]' : sanitized,
    truncation: { truncated, originalBytes } }
}
export function sanitizeSubagentText(input: string) {
  const cleaned = sanitize(input) as string
  return { text: cleaned.slice(0, SUBAGENT_LIMITS.text), truncation: {
    truncated: cleaned.length > SUBAGENT_LIMITS.text, originalBytes: Buffer.byteLength(input) } }
}
function nativeChild(child: RunSubagent) { return child.native.childSessionId ?? child.native.agentId }
function state(value: unknown): RunSubagentTool['status'] {
  return value === 'completed' ? 'completed' : ['failed', 'error', 'declined'].includes(String(value)) ? 'failed'
    : ['interrupted', 'stopped', 'canceled'].includes(String(value)) ? 'canceled'
      : ['running', 'inProgress', 'busy'].includes(String(value)) ? 'running' : value === 'pending' ? 'pending' : 'unknown'
}
const codexChildMethods = ['turn/started', 'turn/completed', 'turn.started', 'turn.completed', 'item/started', 'item/completed', 'item.started', 'item.completed']
/** Queue only evidence a later child discovery could still claim; retrying anything else holds the Run lock for nothing. */
export function isChildCandidate(context: SubagentProjectionContext, event: HarnessNativeEvent, children: readonly RunSubagent[]) {
  if (context.provider === 'codex') {
    const unlinked = event.type === 'native.unlinked_notification'
    const method = unlinked ? String(event.payload.method) : event.type
    const threadId = text(asRecord(unlinked ? event.payload.params : event.payload).threadId)
    return codexChildMethods.includes(method) && threadId !== undefined && threadId !== context.parentSessionId
      && !children.some(child => nativeChild(child) === threadId)
  }
  return event.type === 'native.unlinked_notification' || Boolean(event.payload.parentToolUseId) || Boolean(event.payload.subagentNativeId)
    || event.type === 'claude.subagent' || event.type === 'claude.task'
}
/** Accepts durable, already-owned provider evidence. Foreign notifications are not discovery evidence. */
export function normalizeSubagentEvent(context: SubagentProjectionContext, event: HarnessNativeEvent, children: readonly RunSubagent[], aliases: ReadonlyMap<string, string> = new Map()): SubagentChange[] {
  if (context.provider === 'opencode') return []
  let payload = event.payload
  let method = event.type
  if (method === 'native.unlinked_notification') {
    method = String(payload.method)
    payload = asRecord(payload.params)
  }
  if (context.provider === 'codex') {
    const sessionId = text(payload.threadId)
    const parent = sessionId === context.parentSessionId ? undefined : children.find(child => nativeChild(child) === sessionId)
    const knownParent = sessionId === context.parentSessionId || Boolean(parent)
    const item = asRecord(payload.item)
    if (knownParent && item.type === 'subAgentActivity' && text(item.agentThreadId)) {
      const childId = item.agentThreadId as string
      if (childId === context.parentSessionId || childId === sessionId) return []
      return [{ kind: 'discover', childId, parentSessionId: sessionId!, nativeMode: 'codex-multi-agent-v2',
        // interacted: the parent sent the child new input, so it is working again.
        status: item.kind === 'started' || item.kind === 'interacted' ? event.connectionId?.startsWith('child-history-') ? 'unknown' : 'running'
          : item.kind === 'completed' ? 'completed' : item.kind === 'interrupted' ? 'canceled' : 'unknown',
        ...(text(item.agentPath) ? { agentPath: item.agentPath as string } : {}) }]
    }
    if (knownParent && item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && Array.isArray(item.receiverThreadIds)) {
      const changes: SubagentChange[] = item.receiverThreadIds.filter((id): id is string => Boolean(text(id)) && id !== context.parentSessionId && id !== sessionId)
        .map(childId => ({ kind: 'discover', childId, parentSessionId: sessionId!, nativeMode: 'codex-collab', status: 'pending' }))
      if (parent && text(item.id)) changes.push({ kind: 'tool', childId: nativeChild(parent)!, nativeToolId: item.id as string, name: String(item.tool),
        status: state(item.status), input: item.prompt, output: item.agentsStates })
      return changes
    }
    if (!parent) return []
    const childId = nativeChild(parent)!
    const turn = asRecord(payload.turn)
    const turnId = text(payload.turnId) ?? text(turn.id)
    if (['turn/started', 'turn/completed', 'turn.started', 'turn.completed'].includes(method)) {
      return [{ kind: 'status', childId, status: state(turn.status ?? payload.status), ...(turnId ? { turnId } : {}) }]
    }
    if (!['item/started', 'item/completed', 'item.started', 'item.completed'].includes(method) || !text(item.id)) return []
    const final = method.endsWith('completed')
    if (item.type === 'agentMessage' && typeof item.text === 'string') return [{ kind: 'message', childId, nativeMessageId: item.id as string, role: 'assistant', text: item.text, final }]
    if (item.type === 'userMessage' && Array.isArray(item.content)) return [{ kind: 'message', childId, nativeMessageId: item.id as string, role: 'user',
      text: item.content.map(value => asRecord(value)).filter(value => value.type === 'text' && typeof value.text === 'string').map(value => value.text).join(''), final }]
    if (['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'fileChange'].includes(String(item.type))) return [{ kind: 'tool', childId,
      nativeToolId: item.id as string, name: String(item.tool ?? item.command ?? item.type).slice(0, 512), status: item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'failed' : state(item.status ?? (final ? 'completed' : 'running')),
      input: item.arguments ?? (item.type === 'commandExecution' ? { command: item.command, cwd: item.cwd } : item.changes),
      output: item.type === 'commandExecution' && (typeof item.exitCode === 'number' || item.exitCode === null)
        ? { text: item.aggregatedOutput ?? null, exitCode: item.exitCode } : item.result ?? item.contentItems ?? item.aggregatedOutput,
      error: item.error ?? (item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0 ? { exitCode: item.exitCode } : undefined),
      ...(typeof item.durationMs === 'number' && item.durationMs >= 0 ? { durationMs: item.durationMs } : {}) }]
    return []
  }
  if (payload.nativeSessionId !== context.parentSessionId) return []
  if (method === 'claude.subagent' && text(payload.agentId) && payload.ancestry !== 'verified') {
    return children.some(child => child.native.agentId === payload.agentId) ? [{ kind: 'status', childId: payload.agentId as string, status: state(payload.status) }] : []
  }
  if (method === 'claude.subagent' && text(payload.agentId) && payload.ancestry === 'verified') {
    if (text(payload.parentAgentId) && !children.some(child => child.native.agentId === payload.parentAgentId)) return []
    return [{ kind: 'discover', childId: payload.agentId as string, parentSessionId: text(payload.parentAgentId) ?? context.parentSessionId,
      nativeMode: 'claude-agent', status: state(payload.status), ...(text(payload.taskId) ? { taskId: payload.taskId as string } : {}),
      ...(text(payload.spawnToolUseId) ? { spawnToolUseId: payload.spawnToolUseId as string } : {}) }]
  }
  // Task IDs are not undocumented aliases for agent IDs. Only an explicit verified join may link task and forwarded text.
  const child = children.find(value => method === 'claude.task' ? value.native.taskId === payload.taskId || value.id === aliases.get(`task:${String(payload.taskId)}`)
      || payload.taskType === 'local_agent' && typeof payload.toolUseId === 'string' && (value.native.spawnToolUseId === payload.toolUseId || value.id === aliases.get(`spawn:${String(payload.toolUseId)}`))
    : value.native.agentId === payload.agentId || value.native.spawnToolUseId && value.native.spawnToolUseId === payload.parentToolUseId
      || value.id === aliases.get(`spawn:${String(payload.parentToolUseId)}`))
  if (!child) return []
  const childId = nativeChild(child)!
  if (method === 'claude.task') return [{ kind: 'status', childId, status: state(payload.status),
    ...(text(payload.taskId) ? { taskId: payload.taskId as string, activateTask: payload.taskType === 'local_agent' && payload.status === 'running' } : {}),
    ...(text(payload.toolUseId) ? { spawnToolUseId: payload.toolUseId as string } : {}) }]
  if (method === 'claude.text' && text(payload.itemId) && typeof payload.text === 'string' && payload.operation === 'replace') return [{ kind: 'message', childId,
    nativeMessageId: text(payload.messageId) ?? payload.itemId as string, blockId: typeof payload.contentIndex === 'number' ? `block:${payload.contentIndex}` : payload.itemId as string,
    ...(SubagentTruncationSchema.safeParse(payload.truncation).success ? { nativeTruncation: SubagentTruncationSchema.parse(payload.truncation) } : {}),
    role: payload.role === 'user' ? 'user' : 'assistant', text: payload.text, final: payload.final === true,
    ...(text(payload.parentToolUseId) ? { parentToolUseId: payload.parentToolUseId as string } : {}) }]
  if (method === 'claude.tool' && text(payload.toolUseId)) return [{ kind: 'tool', childId, nativeToolId: payload.toolUseId as string,
    ...(text(payload.name) ? { name: payload.name as string } : {}), status: state(payload.status) as RunSubagentTool['status'],
    input: payload.input, output: payload.output, ...(text(payload.parentToolUseId) ? { parentToolUseId: payload.parentToolUseId as string } : {}) }]
  return []
}
