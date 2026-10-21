import type { SessionMode } from './sessionControls.js'

type SessionCommand =
  | { kind: 'message' }
  | { kind: 'compact' }
  | { kind: 'mode'; mode: SessionMode }
  | { kind: 'plan-task'; task: string }
  | { kind: 'new' }
  | { kind: 'invalid'; message: string }

export function parseSessionCommand(content: string): SessionCommand {
  const matched = /^\/(compact|plan|new)(?:\s+([\s\S]*))?$/.exec(content.trim())
  if (!matched) return { kind: 'message' }
  const argument = matched[2]?.trim() ?? ''
  if (matched[1] === 'compact') return argument
    ? { kind: 'invalid', message: '/compact does not accept arguments.' } : { kind: 'compact' }
  if (matched[1] === 'new') return argument
    ? { kind: 'invalid', message: '/new does not accept arguments.' } : { kind: 'new' }
  if (!argument) return { kind: 'mode', mode: 'plan' }
  if (argument === 'off') return { kind: 'mode', mode: 'regular' }
  if (/^off\s/.test(argument)) return { kind: 'invalid', message: 'Use /plan off to leave Plan mode.' }
  return { kind: 'plan-task', task: argument }
}

export function sessionTaskContent(content: string, mode: SessionMode | undefined): string {
  const command = parseSessionCommand(content)
  return mode === 'plan' && command.kind === 'plan-task' ? command.task : content
}
