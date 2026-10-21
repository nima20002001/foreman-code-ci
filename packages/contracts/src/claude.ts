import { z } from 'zod';
import { APP_MCP_SERVER_NAMES } from './product.js';

const AbsolutePath = z.string().min(1).max(4096).refine((value) => value.startsWith('/') && !value.includes('\0'), 'An absolute local path is required');
const ToolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,199}$/);
export const ClaudeMcpServerNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
export const ClaudeMcpServerSchema = z.object({
  type: z.literal('http'), url: z.url().refine((url) => {
    const value = new URL(url);
    return !value.username && !value.password && !value.hash && !value.search && (value.protocol === 'https:'
      || (value.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(value.hostname)));
  }, 'Use HTTPS or a local HTTP endpoint without credentials'),
}).strict();
/** Supplied by the owning API; browser origins are not MCP endpoint authorities. */
export const ClaudeSetupOptionsSchema = z.object({ graphqlMcp: ClaudeMcpServerSchema.nullable() }).strict();
export const ClaudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
/** Explicit accepted policy. Ambient Claude settings and launch flags are never inputs. */
export const ClaudeHarnessConfigurationSchema = z.object({
  harness: z.literal('claude'), model: z.string().trim().min(1),
  accountId: z.uuid().optional(),
  /** Absent on historical pins; new detected defaults select medium when advertised. */
  effort: ClaudeEffortSchema.optional(),
  authMode: z.enum(['subscription', 'api-key']), configDirectory: AbsolutePath,
  permissionMode: z.literal('default'), sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
  tools: z.array(ToolName).max(100),
  permissionRules: z.array(z.object({ tool: ToolName, effect: z.enum(['allow', 'ask', 'deny']) }).strict()).max(100),
  instructions: z.string().max(200_000),
  mcpServers: z.record(ClaudeMcpServerNameSchema, ClaudeMcpServerSchema),
}).strict().superRefine((value, context) => {
  if (new Set(value.tools).size !== value.tools.length) context.addIssue({ code: 'custom', path: ['tools'], message: 'Tools must be unique' });
  const rules = new Set<string>();
  value.permissionRules.forEach((rule, index) => {
    if (rules.has(rule.tool) || !value.tools.includes(rule.tool)) context.addIssue({ code: 'custom', path: ['permissionRules', index], message: 'Each rule must address one available tool exactly once' });
    rules.add(rule.tool);
  });
});
export type ClaudeHarnessConfiguration = z.infer<typeof ClaudeHarnessConfigurationSchema>;
export const CLAUDE_EXTERNAL_MCP_UNSUPPORTED = 'External MCP servers are not supported by Claude. Only the Foreman Code app MCP connection has an accepted tool manifest.';
export const ClaudeSupportedMcpServersSchema = z.record(ClaudeMcpServerNameSchema, ClaudeMcpServerSchema)
  .superRefine((servers, context) => {
    for (const name of Object.keys(servers)) {
      if (!APP_MCP_SERVER_NAMES.some((supported) => supported === name)) {
        context.addIssue({ code: 'custom', path: [name], message: CLAUDE_EXTERNAL_MCP_UNSUPPORTED });
      }
    }
  }).describe('Only the foreman-code or graphql app HTTP MCP connection is supported; external server manifests are unavailable.');
export const CLAUDE_FULL_ACCESS_REQUIRED = 'Claude requires Full access. Read only and Workspace write are not supported.';
export const ClaudeFullAccessConfigurationSchema = ClaudeHarnessConfigurationSchema.safeExtend({
  mcpServers: ClaudeSupportedMcpServersSchema,
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access'], { error: CLAUDE_FULL_ACCESS_REQUIRED })
    .refine((value): boolean => value === 'danger-full-access', CLAUDE_FULL_ACCESS_REQUIRED),
});
export const ClaudeQuestionInputSchema = z.object({ questions: z.array(z.object({
  question: z.string().min(1).max(10_000), header: z.string().min(1).max(100),
  options: z.array(z.object({ label: z.string().min(1).max(500), description: z.string().max(5000) }).strict()).min(2).max(20),
  multiSelect: z.boolean(),
}).strict()).min(1).max(10) }).strict().superRefine((value, context) => {
  const questions = new Set<string>();
  value.questions.forEach((question, index) => {
    if (questions.has(question.question) || new Set(question.options.map((option) => option.label)).size !== question.options.length)
      context.addIssue({ code: 'custom', path: ['questions', index], message: 'Questions and option labels must be unique' });
    questions.add(question.question);
  });
});
export const ClaudeQuestionAnswersSchema = z.record(z.string(), z.object({ selected: z.array(z.string()).max(20), freeText: z.string().max(10_000).optional() }).strict());

/** Positive native input identity; never a substitute native turn or assistant output identity. */
export const NativeMessageSubmissionSchema = z.object({
  kind: z.literal('message'), nativeSessionId: z.string().min(1), nativeMessageId: z.string().min(1),
  clientCorrelationId: z.string().min(1),
}).strict();
export type NativeMessageSubmission = z.infer<typeof NativeMessageSubmissionSchema>;
