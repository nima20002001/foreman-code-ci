import type { AgentIdentity, WorkflowMention } from '@foreman-code/contracts'

/** Offsets are JavaScript UTF-16 positions in the exact stored body. */
export function editMentionSpans(before: string, after: string, mentions: readonly WorkflowMention[]): WorkflowMention[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let oldEnd = before.length, newEnd = after.length
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd-- }
  const shift = newEnd - oldEnd
  return mentions.flatMap(mention => {
    if (mention.end <= start) return [{ ...mention }]
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + shift, end: mention.end + shift }]
    return []
  })
}

export function insertMention(body: string, mentions: readonly WorkflowMention[], agent: AgentIdentity,
  start: number, end = start) {
  const token = `@${agent.displayName}`
  const next = body.slice(0, start) + token + ' ' + body.slice(end)
  const adjusted = editMentionSpans(body, next, mentions)
  return { body: next, mentions: [...adjusted, { workflowNodeId: agent.workflowNodeId,
    start, end: start + token.length }].sort((a, b) => a.start - b.start), caret: start + token.length + 1 }
}

export function mentionQuery(body: string, caret: number) {
  const prefix = body.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(prefix)
  return match ? { value: match[1]!, start: caret - match[1]!.length - 1, end: caret } : undefined
}

export function agentLabel(agent: AgentIdentity) {
  const role = agent.productRole === 'coder' ? 'Worker' : agent.productRole === 'master' ? 'Master' : 'Orchestrator'
  return `${agent.displayName} · ${role} · ${agent.workflowNodeId}`
}
