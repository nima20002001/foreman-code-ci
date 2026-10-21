import { z } from 'zod'

export const NativeInteractionSupportSchema = z.object({
  kind: z.string().min(1),
  nativeMethod: z.string().min(1),
  label: z.string().min(1),
  supported: z.string().min(1),
  unsupported: z.string().min(1),
}).strict()
type NativeInteractionSupport = z.infer<typeof NativeInteractionSupportSchema>

/** Application response support, independent of native installation readiness. */
export const CODEX_INTERACTION_SUPPORT: NativeInteractionSupport[] = [
  {
    kind: 'tool_user_input', nativeMethod: 'item/tool/requestUserInput', label: 'Questions and MCP tool approvals',
    supported: 'Generic questions, multiple questions, offered choices, free-text and secret answers. '
      + 'Responses must answer every requested question and respect offered choices unless other input is allowed. '
      + 'MCP approval questions retain their offered request, session or persistent choices; '
      + 'ephemeral sessions do not offer session allowances.',
    unsupported: 'Requests without a matching native session and turn cannot be addressed by the active callback.',
  },
  {
    kind: 'mcp_elicitation', nativeMethod: 'mcpServer/elicitation/request', label: 'MCP forms and confirmations',
    supported: 'Session-bound requests, including standalone requests without a turn: URL authorization confirmations with a URL and '
      + 'elicitation ID, or form, openai/form and openaiForm data-entry forms validated against the requested JSON schema. '
      + 'User input is never generated automatically. '
      + 'Session or persistent allowances require explicit MCP tool approval metadata; '
      + 'ephemeral sessions do not offer session allowances.',
    unsupported: 'Requests without the original owned session and request callback cannot be answered.',
  },
]

export const CODEX_UNSUPPORTED_INTERACTION_ERRORS = {
  CODEX_STANDALONE_ELICITATION_UNSUPPORTED: 'Standalone MCP elicitations are unsupported. '
    + 'Confirmations must belong to the active Codex turn; no data was supplied.',
} as const
type CodexUnsupportedInteractionCode = keyof typeof CODEX_UNSUPPORTED_INTERACTION_ERRORS

export function codexUnsupportedInteractionMessage(code: unknown): string | undefined {
  if (typeof code !== 'string' || !Object.hasOwn(CODEX_UNSUPPORTED_INTERACTION_ERRORS, code)) return undefined
  return CODEX_UNSUPPORTED_INTERACTION_ERRORS[code as CodexUnsupportedInteractionCode]
}
