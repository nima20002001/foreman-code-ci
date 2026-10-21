import { z } from 'zod';
import { BoardResultSchema } from './memoryBoards.js';
import { canonicalGraphJson } from './canonicalJson.js';
import { ChoiceOutcomeSchema } from './wave25/choice.js';
import { checkDeliverable } from './wave25/outputContract.js';
import type { WorkflowDefinitionV3 } from './wave25/workflowShape.js';
import { WorkflowArtifactResultV1Schema } from './workflowArtifactDeclarations.js';
import { DelegateRoutingSchema, WorkHandoffRoutingSchema, WorkHandoffDataSchema, WorkflowDelegationContextSchema } from './workflowHierarchy.js';

/** Pinned by production admission; historical Runs retain an absent marker. */
export const COORDINATION_RESULT_PROTOCOL = 'f1-f4-v1' as const;
export const ResultProtocolSchema = z.literal(COORDINATION_RESULT_PROTOCOL);
export type ResultProtocol = z.infer<typeof ResultProtocolSchema>;

export const CoordinationResultFields = {
  summary: z.string().trim().min(1).max(600),
  board: BoardResultSchema,
};
export const PlainCoordinationResultSchema = z.object({ data: z.json(), ...CoordinationResultFields }).strict();
export const ChoiceCoordinationResultSchema = PlainCoordinationResultSchema.extend({
  routing: z.object({ outcome: ChoiceOutcomeSchema }).strict(),
}).strict();
export const ArtifactCoordinationResultSchema = PlainCoordinationResultSchema.extend({
  artifactOutputs: WorkflowArtifactResultV1Schema,
}).strict();
export const ChoiceArtifactCoordinationResultSchema = ChoiceCoordinationResultSchema.extend({
  artifactOutputs: WorkflowArtifactResultV1Schema,
}).strict();
export const HandoffCoordinationResultSchema = z.object({
  routing: z.union([WorkHandoffRoutingSchema, DelegateRoutingSchema]),
  data: WorkHandoffDataSchema, ...CoordinationResultFields,
  artifactOutputs: WorkflowArtifactResultV1Schema.optional(),
}).strict().refine((result) => result.data.latestDeliverable !== null, {
  path: ['data', 'latestDeliverable'], message: 'HANDOFF_DELIVERABLE_REQUIRED',
});

export const RepeatExitDataV1Schema = z.unknown().superRefine((value, context) => {
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'REPEAT_EXIT_DATA_INVALID_OR_TOO_LARGE' }) }
}).pipe(z.object({
  latestDeliverable: z.json().refine((value) => value !== null, 'REPEAT_DELIVERABLE_REQUIRED'),
  remainingFindings: z.array(z.json()),
}).strict())
export type RepeatExitDataV1 = z.infer<typeof RepeatExitDataV1Schema>

export const CoordinationResultSchema = z.union([PlainCoordinationResultSchema, ChoiceCoordinationResultSchema,
  ArtifactCoordinationResultSchema, ChoiceArtifactCoordinationResultSchema, HandoffCoordinationResultSchema,
]).superRefine((result, context) => {
  try { canonicalGraphJson(result, 64 * 1024); }
  catch { context.addIssue({ code: 'custom', message: 'Coordination result exceeds the bounded 64 KiB JSON envelope.' }); }
});
export type CoordinationResult = z.infer<typeof CoordinationResultSchema>;

export type CoordinationResultContext = {
  resultProtocol: ResultProtocol;
  definition: WorkflowDefinitionV3;
  workflowNodeId: string;
  interval?: boolean;
  outstandingRequestIds?: readonly string[];
};

function readCoordinationCarrier(output: unknown, artifact: boolean): unknown {
  const carrier = output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string';
  if (artifact && !carrier) throw new Error('WORKFLOW_ARTIFACT_NATIVE_TEXT_REQUIRED');
  const text = carrier ? (output as { text: string }).text : output;
  if (typeof text === 'string') {
    if (new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error('COORDINATION_RESULT_TOO_LARGE');
    const parsed: unknown = JSON.parse(text);
    canonicalGraphJson(parsed, 64 * 1024);
    return parsed;
  }
  canonicalGraphJson(text, 64 * 1024);
  return text;
}

/** The text of an Agent answer that is not a JSON object, or undefined when it must be read as an envelope. */
function plainTextDeliverable(output: unknown): string | undefined {
  const carrier = output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string';
  const text = carrier ? (output as { text: string }).text : output;
  if (typeof text !== 'string' || text.trim() === '' || new TextEncoder().encode(text).byteLength > 64 * 1024) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return text.trim(); } // ignore: not JSON means plain text.
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? undefined : text.trim();
}

/** Pure parsing of the successful native output, selected by immutable Run protocol and saved node.
 * Existing Runs keep their existing parsers. This function never admits, publishes or repairs work. */
export function parseCoordinationResult(output: unknown, context: CoordinationResultContext): CoordinationResult {
  ResultProtocolSchema.parse(context.resultProtocol);
  const { definition } = context;
  const node = definition.nodes.find((candidate) => candidate.id === context.workflowNodeId);
  if (!node || node.kind === 'job') throw new Error('COORDINATION_AGENT_NODE_REQUIRED');
  const artifacts = context.interval ? undefined : node.artifactOutputs;
  const choice = context.interval ? undefined : node.choice;
  const exitsRepeat = !context.interval && (definition.repeat?.blocks.some((block) => block.exitNodeId === node.id) ?? false);
  // A node with no declared output schema or routing accepts a plain-text answer as its result.
  if (node.outputSchema === undefined && !artifacts && !choice && !exitsRepeat && (context.interval || !definition.handoffs)) {
    const text = plainTextDeliverable(output);
    if (text !== undefined) {
      return { data: text, summary: text.length > 600 ? `${text.slice(0, 599)}…` : text, board: { kind: 'none', reason: 'no_changes' } };
    }
  }
  const raw = readCoordinationCarrier(output, artifacts !== undefined);
  const handoff = !context.interval && definition.handoffs
    ? HandoffCoordinationResultSchema.parse(raw) : undefined;
  let result: CoordinationResult = handoff ?? (choice
    ? artifacts ? ChoiceArtifactCoordinationResultSchema.parse(raw) : ChoiceCoordinationResultSchema.parse(raw)
    : artifacts ? ArtifactCoordinationResultSchema.parse(raw) : PlainCoordinationResultSchema.parse(raw));
  if (artifacts) {
    const actual = 'artifactOutputs' in result && result.artifactOutputs;
    if (!actual || actual.outputs.length !== artifacts.outputKeys.length
      || actual.outputs.some((item) => !artifacts.outputKeys.includes(item.outputKey))) throw new Error('WORKFLOW_ARTIFACT_OUTPUT_KEYS_MISMATCH');
  } else if ('artifactOutputs' in result && result.artifactOutputs !== undefined) throw new Error('WORKFLOW_ARTIFACT_OUTPUTS_UNDECLARED');
  if (handoff) validateCoordinationRouting(handoff, context);
  else if (choice && 'routing' in result && 'outcome' in result.routing) {
    const outcome = result.routing.outcome;
    if (!choice.outcomes.some((declaration) => declaration.outcome === outcome)) throw new Error('CHOICE_OUTCOME_UNDECLARED');
  }
  const repeatExit = !context.interval && definition.repeat?.blocks.some((block) => block.exitNodeId === node.id)
    ? RepeatExitDataV1Schema.parse(result.data) : undefined;
  if (repeatExit) result = { ...result, data: repeatExit };
  const deliverable = repeatExit?.latestDeliverable ?? (handoff ? handoff.data.latestDeliverable : result.data);
  const shouldCheck = !context.interval && (node.outputSchema !== undefined || handoff !== undefined
    || repeatExit !== undefined || (!choice && !artifacts));
  const issues = shouldCheck ? checkDeliverable(deliverable, node.outputSchema) : [];
  if (issues.length) throw new Error(`${issues[0]!.code}: ${issues[0]!.message}`);
  return result;
}

function validateCoordinationRouting(result: z.infer<typeof HandoffCoordinationResultSchema>, context: CoordinationResultContext): void {
  const { definition, workflowNodeId } = context;
  const node = definition.nodes.find((candidate) => candidate.id === workflowNodeId)!;
  if (result.routing.kind === 'delegate') {
    if (!definition.hierarchy) throw new Error('HIERARCHY_DELEGATION_REQUIRED');
    const routes = (node.choice?.outcomes ?? []).flatMap((declaration) => {
      if (declaration.target.kind !== 'edge') return [];
      const relationshipId = declaration.target.relationshipId;
      const edge = definition.edges.find((candidate) => candidate.id === relationshipId
        && candidate.kind === 'execution' && candidate.source === workflowNodeId);
      return edge ? [{ outcome: declaration.outcome, childNodeId: edge.target }] : [];
    });
    WorkflowDelegationContextSchema.parse({ hierarchy: definition.hierarchy, parentNodeId: workflowNodeId, routing: result.routing, routes });
  } else if (result.routing.kind === 'request') {
    const outcome = result.routing.outcome;
    if (!node.choice?.outcomes.some((declaration) => declaration.outcome === outcome && declaration.target.kind === 'edge')) throw new Error('HANDOFF_OUTCOME_UNDECLARED');
  }
  if (definition.hierarchy?.masterNodeId === workflowNodeId && result.routing.kind === 'finish'
    && context.outstandingRequestIds?.length) throw new Error('HIERARCHY_WORK_UNRESOLVED');
  // Valid root findings are a nonfinal direction boundary owned by the engine.
  // They must not be mistaken for malformed output or accepted final success.
}



/** A parsing view for routing/artifact consumers. Stored result bytes are never rewritten. */
export function coordinationBusinessOutput(output: unknown, context: CoordinationResultContext) {
  const parsed = parseCoordinationResult(output, context);
  return { data: parsed.data,
    ...('routing' in parsed ? { routing: parsed.routing } : {}),
    ...('artifactOutputs' in parsed && parsed.artifactOutputs ? { artifactOutputs: parsed.artifactOutputs } : {}),
  };
}
