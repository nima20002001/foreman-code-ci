import type { NativeHarnessEvent, OperatorActivity } from '@foreman-code/contracts'
import { claudeToolTitle } from './activity.js'

/** Minimal bridge to the existing chat activity repository. Arguments, output
 * bodies, private reasoning and child answer text are not inferred into titles. */
export function claudeConversationActivity(event: Pick<NativeHarnessEvent, 'type' | 'payload'>,
  requestId: string): Omit<OperatorActivity, 'sequence' | 'revision'> | undefined {
  const payload = event.payload
  if (event.type === 'claude.task' && typeof payload.taskId === 'string') {
    const status = payload.status
    if (!['running', 'completed', 'failed', 'canceled', 'unknown'].includes(String(status))) return undefined
    return { id: `claude:task:${payload.taskId}`, requestId, kind: 'subagent', title: 'Subagent activity', status: status as OperatorActivity['status'] }
  }
  if (event.type !== 'claude.tool' || typeof payload.itemId !== 'string'
    || !['running', 'completed', 'failed'].includes(String(payload.status))) return undefined
  const name = typeof payload.name === 'string' ? payload.name : undefined
  const kind: OperatorActivity['kind'] = ['Read', 'Glob', 'Grep'].includes(name ?? '') ? 'file_read'
    : ['Write', 'Edit'].includes(name ?? '') ? 'file_write' : ['WebSearch', 'WebFetch'].includes(name ?? '') ? 'web_search'
      : ['Agent', 'Task'].includes(name ?? '') ? 'subagent' : name?.startsWith('mcp__') ? 'mcp' : 'tool'
  return { id: payload.itemId, requestId, kind, title: kind === 'mcp' ? 'MCP tool action' : claudeToolTitle(name), status: payload.status as OperatorActivity['status'] }
}
