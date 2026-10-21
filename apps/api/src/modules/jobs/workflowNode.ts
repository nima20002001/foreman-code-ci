import type { JobExecutionRecord, PreparedJobSpecRecord } from '@foreman-code/contracts/job-verification'
import type { RepeatNodeRef, RepeatResolution } from '../runs/repeatResolution.js'
import type { RepeatGraphState } from '../runs/repeatNode.js'
import { repeatConflict } from '../runs/repeatResolution.js'
import type { ExecutionLimiter } from '../runs/limiter.js'
import type { WorkflowJobAdmission, WorkflowJobDriver } from './workflowRuntimePorts.js'
import type { WorkflowJobPreparation } from './workflowPreparation.js'
export interface WorkflowJobNodeStore {
  prepareJob(ref:RepeatNodeRef):Promise<WorkflowJobAdmission>
  admitPreparedJob(ref:RepeatNodeRef,preparation:WorkflowJobPreparation,spec:PreparedJobSpecRecord):Promise<JobExecutionRecord>
  observeJobState(ref:RepeatNodeRef,executionId:string):Promise<JobExecutionRecord>
  acceptJobTerminal(ref:RepeatNodeRef,executionId:string):Promise<RepeatResolution>
}
export function workflowJobNodeAction(input:{runId:string;store:WorkflowJobNodeStore;driver:WorkflowJobDriver;limiter:ExecutionLimiter;signal:AbortSignal}) {
  return async(ref:RepeatNodeRef,state:RepeatGraphState):Promise<Partial<RepeatGraphState>>=>{
    if(state.runId!==input.runId)repeatConflict('RUN_PIN_CONFLICT')
    input.signal.throwIfAborted()
    const admitted=await input.store.prepareJob(ref)
    if(admitted.kind==='waiting')repeatConflict('WORKFLOW_UNRESOLVED')
    let resolution:RepeatResolution
    if(admitted.kind==='resolved')resolution=admitted.resolution
    else {
      const execution=admitted.kind==='admitted'?admitted.execution:await input.store.admitPreparedJob(ref,admitted.preparation,await input.driver.prepare(admitted.preparation,input.signal))
      await input.limiter.run(input.signal,()=>input.driver.observe(execution,input.signal,()=>input.store.observeJobState(ref,execution.id)))
      input.signal.throwIfAborted()
      resolution=await input.store.acceptJobTerminal(ref,execution.id)
    }
    if(['failed','canceled'].includes(resolution.value.resolution))repeatConflict('WORKFLOW_SELECTED_EXECUTION_FAILED')
    const execution=resolution.value.execution
    return execution?{executionIds:{[ref.nodeId]:{executionId:execution.executionId,occurrenceId:ref.occurrence?.occurrenceId??null}}}:{}
  }
}
