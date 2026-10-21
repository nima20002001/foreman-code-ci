import { Annotation, Command, END, Send, START, StateGraph } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { WorkflowVersionV3Schema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { repeatConflict } from './repeatResolution.js'

const WorkState = Annotation.Root({ runId: Annotation<string>() })
type WorkStateValue = typeof WorkState.State
interface WorkActivationTask extends WorkStateValue { activationId: string }

export interface WorkHandoffGraphPort {
  /** Idempotent durable entry admission on the existing Run owner. */
  ensureEntryActivation(): Promise<string>
  /** Execute or reconcile exactly one activation; return only newly runnable
   * successor IDs. Waiting joins and completed reviews return no extra wake-up. */
  executeActivation(activationId: string, signal: AbortSignal): Promise<readonly string[]>
}

/** The same LangGraph checkpointer/thread and existing Run engine own dynamic
 * work turns. Send carries an activation ID only; SQL remains the authority for
 * input, result, native session, quota and side-effect receipts. */
export function buildWorkHandoffGraph(input: {
  runId: string; version: WorkflowVersionV3; port: WorkHandoffGraphPort
  checkpointer: BaseCheckpointSaver; signal: AbortSignal
  track?: (task: Promise<readonly string[]>) => void
}) {
  const version = WorkflowVersionV3Schema.parse(input.version)
  if (!version.definition.handoffs || version.definition.repeat) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  const send = (activationId: string) => new Send('activation', { runId: input.runId, activationId })
  const graph = new StateGraph(WorkState)
    .addNode('entry', async (state) => {
      input.signal.throwIfAborted()
      if (state.runId !== input.runId) return repeatConflict('RUN_PIN_CONFLICT')
      return new Command({ goto: send(await input.port.ensureEntryActivation()) })
    }, { ends: ['activation'] })
    .addNode('activation', async (value) => {
      input.signal.throwIfAborted()
      const state = value as WorkActivationTask
      if (state.runId !== input.runId || !state.activationId) return repeatConflict('WORK_CHECKPOINT_ACTIVATION_MISSING')
      const task = input.port.executeActivation(state.activationId, input.signal)
      input.track?.(task)
      const successors = await task
      input.signal.throwIfAborted()
      if (new Set(successors).size !== successors.length) return repeatConflict('WORK_SUCCESSOR_DUPLICATE')
      return new Command({ goto: successors.length ? successors.map(send) : END })
    }, { ends: ['activation', END] })
    .addEdge(START, 'entry')
    .compile({ checkpointer: input.checkpointer })
  return { graph,
    config: { configurable: { thread_id: input.runId }, signal: input.signal,
      recursionLimit: Math.min(2147483647, version.definition.executionPolicy!.maxNodeExecutions + 16) },
    initial: { runId: input.runId },
  }
}
