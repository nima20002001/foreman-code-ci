import { z } from 'zod'
import { JobDefinitionSourceSchema } from './jobs.js'
import { JobVerificationPassSchema, JobVerificationSuiteSchema } from './jobVerification.js'
import { IdSchema } from './schemaPrimitives.js'

const JobVerificationGateOutcomeSchema = z.enum([
  'queued', 'running', 'awaiting-approval', 'failed', 'cancelled', 'timed_out', 'incomplete', 'passed',
])
const JobVerificationGatePlanSchema = z.object({
  schemaVersion: z.literal(1),
  workflowId: IdSchema,
  workflowVersionId: IdSchema,
  source: JobDefinitionSourceSchema,
  requiredSteps: z.array(z.object({
    nodeId: IdSchema,
    suite: JobVerificationSuiteSchema,
    definitionId: IdSchema,
    definitionRevision: z.number().int().positive(),
    definitionVersionId: IdSchema,
  }).strict()).min(1).max(64),
}).strict().refine(value => new Set(value.requiredSteps.map(step => step.nodeId)).size === value.requiredSteps.length,
  'Each required suite Job has one workflow node.')

/** Composition uses saved workflow Job nodes; it never dispatches commands from a gate container. */
export const JobVerificationGateResultSchema = z.object({
  schemaVersion: z.literal(1),
  id: IdSchema,
  runId: IdSchema,
  plan: JobVerificationGatePlanSchema,
  outcome: JobVerificationGateOutcomeSchema,
  children: z.array(z.object({
    nodeId: IdSchema,
    definitionVersionId: IdSchema,
    suite: JobVerificationSuiteSchema,
    ticketId: z.uuid().nullable(),
    executionId: IdSchema.nullable(),
    attemptId: IdSchema.nullable(),
    outcome: JobVerificationGateOutcomeSchema,
    pass: JobVerificationPassSchema.nullable(),
  }).strict()).max(64),
}).strict().superRefine((value, context) => {
  const nodes = new Set(value.children.map(child => child.nodeId))
  if (nodes.size !== value.children.length) {
    context.addIssue({ code: 'custom', message: 'Gate children must retain distinct workflow nodes.' })
  }
  for (const child of value.children) {
    const step = value.plan.requiredSteps.find(required => required.nodeId === child.nodeId)
    if (!step || step.definitionVersionId !== child.definitionVersionId || step.suite !== child.suite) {
      context.addIssue({ code: 'custom', message: 'A gate child belongs to another saved suite definition.' })
    }
    if ((child.outcome === 'passed') !== (child.pass !== null)) {
      context.addIssue({ code: 'custom', message: 'A passed child requires complete verified process and output results.' })
    }
    if (child.pass) {
      const report = child.pass.report
      if (report.commit !== value.plan.source.commit || report.manifestDigest !== value.plan.source.manifestDigest
        || report.executionId !== child.executionId || report.attemptId !== child.attemptId
        || report.definitionVersionId !== child.definitionVersionId || report.suite !== child.suite) {
        context.addIssue({ code: 'custom', message: 'A child report must match the gate source and visible execution attempt.' })
      }
    }
  }
  if (value.outcome === 'passed' && (value.children.length !== value.plan.requiredSteps.length
    || value.children.some(child => child.outcome !== 'passed'))) {
    context.addIssue({ code: 'custom', message: 'A gate passes only when every required suite Job passes.' })
  }
})
