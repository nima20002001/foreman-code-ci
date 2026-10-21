import { asRecord } from '../../shared/records.js'
import type pg from 'pg'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import {
  AgentChatExecutionActivityPageSchema, type AgentChatExecutionActivityPage, type AgentChatExecutionItem,
  type AgentChatExecutionSummary,
} from '@foreman-code/contracts/agent-chat'
import { z } from 'zod'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { operatorActivity } from './operatorActivity.js'
import { executionItemsSql } from './executionActivitySql.js'
import { DomainError } from '../errors.js'

const MAX_EXECUTIONS = 20
const PAGE_BYTES = 256 * 1024
// Keep complete application tokens, including JSON escapes, available to the redactor before clipping.
const REDACTION_LOOKAHEAD = 384
/** Live pages carry previews; an item read returns the full bounded bodies. */
const PREVIEW = { message: 16_384, input: 2_000, output: 4_000 }
const FULL = { message: 65_536, input: 16_000, output: 24_000 }
type Limits = typeof PREVIEW

interface ExecutionRow {
  id: string; attempt: number; tick_index: number | null; occurrence_index: string | null; state: AgentChatExecutionSummary['state']
  native_session_id: string | null; created_at: Date; started_at: string | null; finished_at: string | null; revision: string; record_revision: string
}
export interface ExecutionEventRow {
  sequence: number; item_key: string
  record: { type?: unknown; payload?: unknown; occurredAt?: unknown; connectionId?: unknown }
}
type Payload = Record<string, unknown>
export interface ExecutionActivityScope { workspaceId: string; workflowId: string; runId: string; workflowNodeId: string; agentId: string }
export interface ExecutionActivityRequest {
  cursor?: string | undefined; executionId?: string | undefined; before?: string | undefined; itemId?: string | undefined; limit?: number | undefined
}

const executionsSql = `select e.id,e.attempt,e.tick_index,e.record#>>'{input,occurrence,identity,occurrenceIndex}' as occurrence_index,
  e.record->>'state' as state,e.record->>'nativeSessionId' as native_session_id,e.created_at,
  e.record->>'startedAt' as started_at,e.record->>'finishedAt' as finished_at,
  coalesce((select max(n.sequence) from harness_native_events n where n.execution_id=e.id),-1)::text as revision,
  e.activity_record_revision::text as record_revision
  from harness_executions e join runs r on r.id=e.run_id
  where e.run_id=$1 and e.workflow_node_id=$2 and e.agent_id=$3 and r.workspace_id=$4 and r.workflow_id=$5
  and ($6::text is null or e.id=$6)
  order by e.created_at desc,e.id desc limit ${MAX_EXECUTIONS + 1}`

const RevisionSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)
const CursorEntrySchema = z.object({
  n: z.union([RevisionSchema, z.literal('-1')]),
  e: RevisionSchema,
  t: z.boolean(),
  after: z.object({ r: RevisionSchema, k: z.string().min(1).max(1024), t: z.boolean() }).optional(),
})
const CursorSchema = z.record(z.string().min(1), CursorEntrySchema)
const VersionedCursorSchema = z.object({ version: z.literal(2), executions: CursorSchema }).strict()
type CursorEntry = z.infer<typeof CursorEntrySchema>
function parseCursor(value: string | undefined): Record<string, CursorEntry> | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    const versioned = VersionedCursorSchema.safeParse(parsed)
    if (versioned.success) return versioned.data.executions
    const legacy = CursorSchema.parse(parsed)
    // Old cursors conflate an empty journal and sequence zero; replay that boundary once.
    for (const entry of Object.values(legacy)) {
      if (entry.n === '0') entry.n = '-1'
    }
    return legacy
  } catch (cause) {
    const error = new DomainError('EXECUTION_ACTIVITY_CURSOR_INVALID',
      'Execution activity cursor is invalid. Read again without a cursor.', 400)
    error.cause = cause
    throw error
  }
}
function prefix(value: string, bytes: number) {
  const buffer = Buffer.from(value)
  return new TextDecoder().decode(buffer.subarray(0, bytes), { stream: buffer.length > bytes })
}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const STREAMED_METHODS = ['item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta', 'item/plan/delta']

function label(row: ExecutionRow) {
  const attempt = row.attempt > 1 ? ` · attempt ${row.attempt}` : ''
  if (row.tick_index !== null) return `Loop ${row.tick_index}${attempt}`
  if (row.occurrence_index !== null) return `Occurrence ${row.occurrence_index}${attempt}`
  return row.attempt > 1 ? `Attempt ${row.attempt}` : 'Execution'
}
function isMessageEvent(type: string, payload: Payload) {
  return ['item.started', 'item.completed'].includes(type) && ['agentMessage', 'userMessage'].includes(text(asRecord(payload.item).type))
    || type === 'assistant.delta' || type === 'claude.text' || payload.nativeMethod === 'item/agentMessage/delta'
}
function messageText(payload: Payload) {
  const item = asRecord(payload.item)
  if (item.type === 'userMessage') return (Array.isArray(item.content) ? item.content : []).map(asRecord)
    .filter((part) => part.type === 'text').map((part) => text(part.text)).join('')
  return text(item.text) || text(payload.text) || text(payload.delta)
}
/** Keeps a UTF-8 prefix while counting all appended bytes. */
function append(previous: { value: string; length: number }, next: string, limit: number) {
  return { value: prefix(previous.value + next, limit), length: previous.length + Buffer.byteLength(next) }
}

type Activity = NonNullable<ReturnType<typeof operatorActivity>>
interface Entry {
  key: string; sequence: number; revision: number; occurredAt?: string
  message?: { role: 'user' | 'assistant'; content: { value: string; length: number }; complete: boolean; originalBytes: number }
  activity?: Activity; inputStream?: { value: string; length: number }; streamed: { value: string; length: number }
}

/** Incremental public projection of one execution's native events. Exported for behavior tests. */
export class ExecutionActivityFold {
  sequence = -1
  private readonly entries = new Map<string, Entry>()

  apply(rows: readonly ExecutionEventRow[]) {
    for (const row of rows) {
      if (row.sequence <= this.sequence) continue
      this.sequence = row.sequence
      const type = text(row.record.type), payload = asRecord(row.record.payload)
      if (!row.item_key) continue
      const message = isMessageEvent(type, payload)
      const key = message && payload.contentIndex !== undefined ? `${row.item_key}#${String(payload.contentIndex)}` : row.item_key
      let entry = this.entries.get(key)
      if (!entry) {
        entry = { key, sequence: row.sequence, revision: row.sequence, streamed: { value: '', length: 0 },
          ...(typeof row.record.occurredAt === 'string' ? { occurredAt: row.record.occurredAt } : {}) }
        this.entries.set(key, entry)
      }
      if (message) this.foldMessage(entry, type, payload)
      else if (!this.foldActivity(entry, row, type, payload)) continue
      entry.revision = row.sequence
    }
  }

  private foldMessage(entry: Entry, type: string, payload: Payload) {
    const current = entry.message ??= { role: 'assistant', content: { value: '', length: 0 }, complete: false, originalBytes: 0 }
    if (asRecord(payload.item).type === 'userMessage' || payload.role === 'user') current.role = 'user'
    const truncation = asRecord(payload.truncation)
    if (typeof truncation.originalBytes === 'number') current.originalBytes = Math.max(current.originalBytes, truncation.originalBytes)
    if (current.complete) return
    const final = type === 'item.completed' || type === 'claude.text' && payload.final === true
    const replaces = type === 'item.started' || final || payload.operation === 'replace'
    current.content = append(replaces ? { value: '', length: 0 } : current.content, messageText(payload), FULL.message)
    current.complete = final
  }

  private foldActivity(entry: Entry, row: ExecutionEventRow, type: string, payload: Payload): boolean {
    const method = text(payload.nativeMethod)
    if (method === 'turn/plan/updated') {
      const steps = (Array.isArray(payload.plan) ? payload.plan : []).map(asRecord)
        .map((step) => `${step.status === 'completed' ? '[x]' : step.status === 'inProgress' ? '[~]' : '[ ]'} ${text(step.step)}`)
      entry.activity = { id: entry.key, requestId: text(payload.turnId) || 'plan', kind: 'tool', title: 'Update plan', status: 'completed',
        output: text(payload.publicOutput) || [text(payload.explanation), ...steps].filter(Boolean).join('\n'),
        ...(payload.publicTruncated === true ? { truncated: true } : {}) }
      return true
    }
    if (STREAMED_METHODS.includes(method)) { entry.streamed = append(entry.streamed, text(payload.delta), FULL.output); return true }
    const item = asRecord(payload.item)
    if (item.type === 'plan' && ['item.started', 'item.completed'].includes(type)) {
      entry.activity = { id: text(item.id), requestId: text(payload.turnId) || 'plan', kind: 'tool', title: 'Plan',
        status: type === 'item.completed' ? 'completed' : 'running',
        ...(text(payload.publicOutput) || text(item.text) ? { output: text(payload.publicOutput) || text(item.text) } : {}),
        ...(payload.publicTruncated === true ? { truncated: true } : {}) }
      return true
    }
    const event: NativeHarnessEvent = { sequence: row.sequence, type, payload,
      occurredAt: typeof row.record.occurredAt === 'string' ? row.record.occurredAt : new Date(0).toISOString(),
      ...(typeof row.record.connectionId === 'string' ? { connectionId: row.record.connectionId } : {}) }
    let next = operatorActivity(event, type.startsWith('claude.') ? 'claude' : 'codex', text(payload.turnId) || 'execution')
    if (!next) return false
    if (type === 'claude.tool') next = this.foldClaudeTool(entry, payload, next)
    if (typeof payload.publicInput === 'string') next = { ...next, input: payload.publicInput }
    if (typeof payload.publicOutput === 'string') next = { ...next, output: payload.publicOutput }
    if (payload.publicTruncated === true) next = { ...next, truncated: true }
    if (typeof payload.publicTitle === 'string') next = { ...next, title: payload.publicTitle }
    // Show an MCP result's text parts, not its protocol envelope.
    const parts = Array.isArray(asRecord(item.result).content) ? (asRecord(item.result).content as unknown[]).map(asRecord) : []
    const resultText = item.type === 'mcpToolCall' && item.error == null
      ? parts.filter((part) => part.type === 'text').map((part) => text(part.text)).join('\n') : ''
    // A shell row names its command, so the collapsed one-line row says what ran.
    const command = item.type === 'commandExecution' && next.title === 'Run command'
      ? (Array.isArray(item.commandActions) ? item.commandActions.map(asRecord).map((action) => text(action.command)).filter(Boolean).join(' && ') : '')
        || text(item.command) : ''
    entry.activity = { ...next, ...(resultText ? { output: resultText.slice(0, FULL.output) } : {}),
      ...(command ? { title: command.replace(/\s+/g, ' ').slice(0, 240) } : {}) }
    return true
  }

  private foldClaudeTool(entry: Entry, payload: Payload, activity: Activity): Activity {
    const body = (value: unknown): string => {
      if (typeof value === 'string') return value
      if (Array.isArray(value) && value.every((part) => asRecord(part).type === 'text')) {
        return value.map((part) => text(asRecord(part).text)).join('\n')
      }
      return value == null ? '' : JSON.stringify(value, null, 2)
    }
    let input = entry.activity?.input
    let output = entry.activity?.output
    let truncated = entry.activity?.truncated ?? false
    if (payload.input !== undefined) {
      const value = body(payload.input)
      input = prefix(value, FULL.input)
      truncated ||= Buffer.byteLength(value) > FULL.input
      delete entry.inputStream
    } else if (typeof payload.inputJsonDelta === 'string') {
      entry.inputStream = append(entry.inputStream ?? { value: '', length: 0 }, payload.inputJsonDelta, FULL.input)
      input = entry.inputStream.value
      truncated ||= entry.inputStream.length > Buffer.byteLength(input)
    }
    if (payload.output !== undefined) {
      const value = body(payload.output)
      output = prefix(value, FULL.output)
      truncated ||= Buffer.byteLength(value) > FULL.output
    }
    const command = text(asRecord(payload.input).command)
    const file = text(asRecord(payload.input).file_path)
    let title = activity.title
    if (payload.name === 'Bash' && command) title = command.replace(/\s+/g, ' ')
    else if (file) title = `${text(payload.name)} ${file}`
    else if (payload.input === undefined && entry.activity?.kind === activity.kind) title = entry.activity.title
    else if (activity.kind === 'mcp') title = text(payload.name)
    return { ...activity, title: prefix(title, 240),
      ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}),
      ...(truncated ? { truncated: true } : {}) }
  }

  /** Public items, oldest first. */
  items(executionId: string, terminal: boolean, limits: Limits = PREVIEW): AgentChatExecutionItem[] {
    const redactor = nativePersistenceRedactor([])
    const items: AgentChatExecutionItem[] = []
    for (const entry of this.entries.values()) {
      const base = { executionId, id: entry.key, sequence: String(entry.sequence), revision: String(entry.revision),
        ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}) }
      if (entry.message) {
        const { role, content, complete, originalBytes } = entry.message
        const safe = prefix(redactor.text(content.value), limits.message)
        const total = Math.max(originalBytes, content.length)
        items.push({ ...base, entry: { kind: 'message', message: { id: JSON.stringify([executionId, entry.key]), role, content: safe,
          sequence: base.sequence, revision: base.revision, nativeMessageComplete: complete,
          ...(entry.occurredAt ? { createdAt: entry.occurredAt } : {}),
          ...(total > Buffer.byteLength(safe) ? { truncation: { truncated: true, originalBytes: Math.max(total, Buffer.byteLength(safe)) } } : {}) } } })
        continue
      }
      let activity = entry.activity
      if (!activity) continue
      const live = activity.status !== 'completed' && !activity.output && entry.streamed.length > 0
      if (live) activity = { ...activity, output: entry.streamed.value, ...(entry.streamed.length > Buffer.byteLength(entry.streamed.value) ? { truncated: true } : {}) }
      // Empty reasoning items carry no public summary.
      if (activity.kind === 'thinking' && !activity.output) continue
      const status = terminal && (activity.status === 'running' || activity.status === 'pending') ? 'unknown' : activity.status
      const input = activity.input === undefined ? undefined : redactor.text(activity.input)
      const output = activity.output === undefined ? undefined : redactor.text(activity.output)
      const truncated = activity.truncated || Buffer.byteLength(input ?? '') > limits.input || Buffer.byteLength(output ?? '') > limits.output
      items.push({ ...base, entry: { kind: 'activity', activity: { id: activity.id, kind: activity.kind,
        title: prefix(redactor.text(activity.title), 240), status,
        ...(input !== undefined ? { input: prefix(input, limits.input) } : {}),
        ...(output !== undefined ? { output: prefix(output, limits.output) } : {}),
        ...(truncated ? { truncated: true } : {}) } } })
    }
    return items.sort((a, b) => Number(a.sequence) - Number(b.sequence))
  }
}

interface ProjectedRow {
  item_key: string
  first_sequence: string
  revision: string
  record: ExecutionEventRow['record'] | null
}
interface ItemWindow {
  items: AgentChatExecutionItem[]
  rows: ProjectedRow[]
  hasMore: boolean
}
function projectionRevision(native: string, execution: string) {
  const nativeRevision = BigInt(native)
  return String((nativeRevision < 0n ? 0n : nativeRevision) + BigInt(execution))
}
function terminalState(state: AgentChatExecutionSummary['state']) {
  return state === 'completed'
}
function fitItem(item: AgentChatExecutionItem, budget: number): AgentChatExecutionItem | undefined {
  let bounded = item
  while (Buffer.byteLength(JSON.stringify(bounded)) > budget) {
    if (bounded.entry.kind === 'message') {
      const message = bounded.entry.message
      const bytes = Buffer.byteLength(message.content)
      if (bytes === 0) return undefined
      bounded = { ...bounded, entry: { kind: 'message', message: { ...message,
        content: prefix(message.content, Math.floor(bytes / 2)),
        truncation: { truncated: true, originalBytes: Math.max(bytes, message.truncation?.originalBytes ?? 0) },
      } } }
    } else {
      const activity = bounded.entry.activity
      const inputBytes = Buffer.byteLength(activity.input ?? '')
      const outputBytes = Buffer.byteLength(activity.output ?? '')
      if (inputBytes + outputBytes === 0) return undefined
      bounded = { ...bounded, entry: { kind: 'activity', activity: { ...activity, truncated: true,
        ...(activity.input !== undefined ? { input: prefix(activity.input, Math.floor(inputBytes / 2)) } : {}),
        ...(activity.output !== undefined ? { output: prefix(activity.output, Math.floor(outputBytes / 2)) } : {}),
      } } }
    }
  }
  return bounded
}

/** Shared bounded database projection for HTTP and MCP. History is read from the journal, not retained in RAM. */
export class ExecutionActivityReader {
  constructor(private readonly sql: Pick<pg.Pool, 'query'>) {}

  private async window(row: ExecutionRow, request: ExecutionActivityRequest,
    options: { mode: string; limit: number; budget: number; known?: CursorEntry }): Promise<ItemWindow> {
    const full = request.itemId !== undefined
    const limits = full ? FULL : PREVIEW
    const recordRevision = row.record_revision
    const terminal = terminalState(row.state)
    const after = options.known?.after?.t === terminal ? options.known.after : undefined
    const result = await this.sql.query<ProjectedRow>(executionItemsSql, [
      row.id, row.native_session_id, options.mode, options.known?.n ?? '0', request.before ?? null,
      request.itemId ?? null, after?.r ?? null, after?.k ?? null, options.limit + 1,
      limits.message + REDACTION_LOOKAHEAD, limits.input + REDACTION_LOOKAHEAD,
      limits.output + REDACTION_LOOKAHEAD, options.budget,
      options.known !== undefined && options.known.t !== terminal,
    ])
    const redactor = nativePersistenceRedactor([])
    const projectedItems = result.rows.flatMap((projected): AgentChatExecutionItem[] => {
      if (!projected.record) return []
      const fold = new ExecutionActivityFold()
      fold.apply([{ sequence: 0, item_key: projected.item_key, record: redactor.value(projected.record) }])
      const item = fold.items(row.id, terminal, limits)[0]
      if (!item) return []
      const sequence = String(projected.first_sequence)
      const revision = projectionRevision(String(projected.revision), recordRevision)
      if (item.entry.kind === 'message') {
        return [{ ...item, sequence, revision,
          entry: { ...item.entry, message: { ...item.entry.message, sequence, revision } } }]
      }
      return [{ ...item, sequence, revision }]
    })
    const byId = new Map(projectedItems.map((item) => [item.id, item]))
    const items: AgentChatExecutionItem[] = []
    const rows: ProjectedRow[] = []
    let hasMore = false
    let budget = options.budget - 2
    for (const projected of result.rows) {
      if (!projected.record || items.length === options.limit) {
        hasMore = true
        break
      }
      const item = byId.get(projected.item_key)
      if (item) {
        const bounded = items.length === 0 ? fitItem(item, budget) : item
        if (!bounded || Buffer.byteLength(JSON.stringify(bounded)) + 1 > budget) {
          hasMore = true
          break
        }
        items.push(bounded)
        budget -= Buffer.byteLength(JSON.stringify(bounded)) + 1
      }
      rows.push(projected)
    }
    return { items, rows, hasMore }
  }

  async read(scope: ExecutionActivityScope, request: ExecutionActivityRequest): Promise<AgentChatExecutionActivityPage> {
    const limit = request.limit ?? 200
    const rows = (await this.sql.query<ExecutionRow>(executionsSql,
      [scope.runId, scope.workflowNodeId, scope.agentId, scope.workspaceId, scope.workflowId,
        request.executionId ?? null])).rows
    const hasEarlierExecutions = rows.length > MAX_EXECUTIONS
    const newest = rows.slice(0, MAX_EXECUTIONS)
    const summaries = new Map<string, AgentChatExecutionSummary>(newest.map((row) => [row.id, {
      executionId: row.id, label: label(row), attempt: row.attempt,
      ...(row.tick_index !== null ? { tickIndex: row.tick_index } : {}),
      state: row.state, createdAt: row.created_at.toISOString(),
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      revision: projectionRevision(String(row.revision), row.record_revision),
    }]))
    const page = (mode: AgentChatExecutionActivityPage['mode'], items: AgentChatExecutionItem[],
      extra: Partial<AgentChatExecutionActivityPage> = {}) => AgentChatExecutionActivityPageSchema.parse({
        mode, executions: [...summaries.values()].reverse(), hasEarlierExecutions,
        items, hasMoreChanges: false, ...extra,
      })
    const budget = PAGE_BYTES - Buffer.byteLength(JSON.stringify([...summaries.values()])) - 8192
    if (request.executionId) {
      const mode = request.itemId ? 'item' : 'earlier'
      const row = newest.find((entry) => entry.id === request.executionId)
      if (!row) return page(mode, [])
      const window = await this.window(row, request, { mode, limit: request.itemId ? 1 : limit, budget })
      if (!request.itemId) summaries.set(row.id, { ...summaries.get(row.id)!, hasEarlierItems: window.hasMore })
      return page(mode, window.items)
    }

    const cursor = parseCursor(request.cursor)
    const next: Record<string, CursorEntry> = {}
    const list: AgentChatExecutionItem[] = []
    let remaining = limit
    let remainingBytes = budget
    let hasMoreChanges = false
    for (const row of newest) {
      const known = cursor?.[row.id]
      const recordRevision = row.record_revision
      const terminal = terminalState(row.state)
      const settled = known && !known.after && BigInt(row.revision) <= BigInt(known.n) && known.t === terminal
      if (settled) {
        next[row.id] = { ...known, e: recordRevision }
        continue
      }
      if (remaining === 0 || remainingBytes <= 0) {
        if (known) {
          next[row.id] = known
          hasMoreChanges = true
        } else {
          summaries.set(row.id, { ...summaries.get(row.id)!, hasEarlierItems: BigInt(row.revision) >= 0n })
        }
        continue
      }
      const window = await this.window(row, request, { mode: known ? 'changes' : 'snapshot',
        limit: remaining, budget: remainingBytes, ...(known ? { known } : {}) })
      list.push(...window.items)
      remaining -= window.items.length
      remainingBytes -= Buffer.byteLength(JSON.stringify(window.items))
      if (known && window.hasMore) {
        const last = window.rows.at(-1)
        next[row.id] = { n: known.n, e: known.e, t: known.t,
          ...(last ? { after: { r: String(last.revision), k: last.item_key, t: terminal } } : {}) }
        hasMoreChanges = true
      } else {
        next[row.id] = { n: String(row.revision), e: recordRevision, t: terminal }
      }
      if (!known) summaries.set(row.id, { ...summaries.get(row.id)!, hasEarlierItems: window.hasMore })
    }
    const order = new Map(newest.map((row, index) => [row.id, newest.length - index]))
    list.sort((a, b) => order.get(a.executionId)! - order.get(b.executionId)!
      || (BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1))
    return page(cursor ? 'changes' : 'snapshot', list, { cursor: JSON.stringify({ version: 2, executions: next }), hasMoreChanges })
  }
}
