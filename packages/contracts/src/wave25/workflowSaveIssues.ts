import { z } from 'zod'

/** Shared HTTP/MCP validation details. Paths refer to the submitted workflow graph. */
const WorkflowSaveIssueSchema = z.object({
  code: z.string(), path: z.array(z.union([z.string(), z.number()])), message: z.string(),
  minimum: z.number().optional(), actual: z.number().optional(),
}).strict()
export const WorkflowSaveIssuesSchema = z.object({ issues: z.array(WorkflowSaveIssueSchema) })
export type WorkflowSaveIssue = z.infer<typeof WorkflowSaveIssueSchema>

export function workflowSaveIssues(issues: z.core.$ZodIssue[]): WorkflowSaveIssue[] {
  const result = issues.map((issue) => {
    const path = issue.path.filter((part): part is string | number => typeof part !== 'symbol')
    while (['version', 'definition'].includes(String(path[0]))) path.shift()
    const limit = path[0] === 'executionPolicy' ? path[1] : undefined
    if (issue.code !== 'custom' && limit === 'agentActiveTimeoutMs') return {
      code: 'INVALID_EXECUTION_LIMIT', path,
      message: 'Enter an Agent active-time budget between 0.001 and 2147483.647 seconds, or leave it blank for the server default.',
    }
    if (issue.code !== 'custom' && (limit === 'maxParallelism' || limit === 'maxNodeExecutions')) return {
      code: 'INVALID_EXECUTION_LIMIT', path,
      message: `Enter a positive whole number for “${limit === 'maxParallelism' ? 'Maximum parallelism' : 'Maximum node executions'}”.`,
    }
    const params = issue.code === 'custom' ? issue.params : undefined
    return WorkflowSaveIssueSchema.parse({
      code: params?.issueCode ?? issue.code, path, message: issue.message,
      ...(typeof params?.minimum === 'number' ? { minimum: params.minimum } : {}),
      ...(typeof params?.actual === 'number' ? { actual: params.actual } : {}),
    })
  })
  return result.filter((issue, index) => result.findIndex((other) =>
    other.code === issue.code && other.message === issue.message && JSON.stringify(other.path) === JSON.stringify(issue.path)) === index)
}
