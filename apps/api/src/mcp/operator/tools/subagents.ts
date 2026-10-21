import { RunSubagentsListInputSchema, RunSubagentGetInputSchema, RunSubagentItemsInputSchema, RunSubagentInputSchema, RunSubagentInterruptSchema,
  RunSubagentsPageSchema, RunSubagentDetailSchema, RunSubagentMessagesPageSchema, RunSubagentToolsPageSchema,
  RunSubagentCommandReceiptSchema, RunSubagentRespondSchema } from '@foreman-code/contracts/subagents'
import { defineOperatorTool } from '../definition.js'

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const command = { ...read, readOnlyHint: false }
export const subagentTools = [
  defineOperatorTool({
    name: 'run_subagents_list_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'List durable native children attached to one exact Run, including completed children, native mode, evidence, coverage and qualified capabilities. Requires scoped runs:read. When projection is busy, returns saved children with projection catching-up; poll again for newer activity. These records never edit the saved Board.',
    inputSchema: RunSubagentsListInputSchema, outputSchema: RunSubagentsPageSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.list(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_get_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Read the exact child, its pending native interaction and currently available actions. Native protocol support, app qualification and live computer ownership are separate; unavailable controls grant no session access. Codex supports child turn steering, idle input, targeted interruption and explicit approval/input responses through its admitted owner.',
    inputSchema: RunSubagentGetInputSchema, outputSchema: RunSubagentDetailSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.get(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_messages_list_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Read a bounded chronological child transcript page with native identity, provenance, finality and truncation/coverage. Re-read from the start to refresh changed messages; cursor is for older immutable ordering, scoped to this child.',
    inputSchema: RunSubagentItemsInputSchema, outputSchema: RunSubagentMessagesPageSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.messages(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_tools_list_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Read child tool calls and native results with sanitized arguments, errors, timings and truncation/coverage. Tool-like model text is never execution evidence. Requires scoped runs:read.',
    inputSchema: RunSubagentItemsInputSchema, outputSchema: RunSubagentToolsPageSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.tools(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_input_v1',
    requires: [['runs:subagents:input', 'run'], ['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Send exact child input only where qualified, currently available and owned by its admitted computer manager. Requires runs:read plus explicit runs:subagents:input on the same Run. Pin expectedRevision and retain commandId. A native ACK is acceptance, not consumption. Uncertain retries read the receipt without resending. Codex active input targets the child turn; idle input preserves the child settings. Claude direct input is unavailable.',
    inputSchema: RunSubagentInputSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: command,
    run: (context, input) => context.services.runs.subagents!.input(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'run_subagent_interrupt_v1',
    requires: [['runs:stop', 'run'], ['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Interrupt one exact active child only with qualified targeted cancellation, current computer lease, scoped runs:stop and runs:read. Pin expectedRevision and retain commandId. ACK never marks the child finished; observed provider cancellation remains required. Codex interruption addresses the child thread and turn.',
    inputSchema: RunSubagentInterruptSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: { ...command, destructiveHint: true },
    run: (context, input) => context.services.runs.subagents!.interrupt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'run_subagent_respond_v1',
    requires: [['interactions:respond', 'run'], ['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Answer the owned child callback from run_subagent_get_v1 using its nativeRequestId and an offered '
      + 'optionId. Supply response for questions/forms. Requires scoped runs:read and interactions:respond. '
      + 'Pin expectedRevision and reuse commandId with identical input after response loss; uncertain responses are never resent.',
    inputSchema: RunSubagentRespondSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: command,
    run: (context, input) => context.services.runs.subagents!.respond(context.principal, 'mcp', input),
  }),
]
