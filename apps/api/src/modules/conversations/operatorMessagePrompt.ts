import { sessionTaskContent, type SendOperatorMessageRequest } from '@foreman-code/contracts'

/** Shared by admission and native delivery so saved context uses the same budget. */
export function operatorMessagePrompt(input: SendOperatorMessageRequest, initialPrompt: string | undefined,
  handoffContext: string | null): string {
  const userPrompt = sessionTaskContent(input.content, input.sessionMode)
  const hint = input.context && Object.values(input.context).some(Boolean)
    ? `\n\n[Non-authoritative route context: ${JSON.stringify(input.context)}]` : ''
  const preamble = [initialPrompt, handoffContext].filter(Boolean).join('\n\n')
  const prefix = preamble ? `${preamble}\n\nCurrent user message:\n` : ''
  return `${prefix}${userPrompt}${hint}`
}
