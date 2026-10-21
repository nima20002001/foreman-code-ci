import type { ComponentType } from 'react'
import type { WorkflowExecutionChatResolution, WorkflowExecutionChatSelection,
  WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import type { executionChatReadKey, WorkflowExecutionChatClient } from './client'

export interface WorkflowExecutionChatNavigation {
  onSelectTarget(target:WorkflowExecutionChatTarget,workflowVersionId:string):void
  onSelectRun(scope:{runId:string;workflowVersionId:string}):void
}
/** The shared rail supplies URL-owned pins and atomic navigation callbacks. */
export type WorkflowExecutionChatSlotSelection =
  Omit<WorkflowExecutionChatSelection,'workflowNodeId'|'cursor'|'limit'>
  & WorkflowExecutionChatNavigation & {nodeId:string}

export interface WorkflowExecutionChatViewProps extends WorkflowExecutionChatNavigation {
  selection:WorkflowExecutionChatSelection
  resolved:Extract<WorkflowExecutionChatResolution,{kind:'selected'}>
  client:WorkflowExecutionChatClient
  queryKey:ReturnType<typeof executionChatReadKey>
}
export interface WorkflowOutsideRunChatViewProps extends WorkflowExecutionChatNavigation {
  selection:WorkflowExecutionChatSelection
  resolved:Extract<WorkflowExecutionChatResolution,{kind:'outside_run'}>
}
/** F3 owns the transcript/composer, drafts, native activity and one visible
 * subscription. D supplies exact Run resolution and the real HTTP boundary. */
export interface WorkflowExecutionChatViews {
  ExecutionChat:ComponentType<WorkflowExecutionChatViewProps>
  OutsideRunChat:ComponentType<WorkflowOutsideRunChatViewProps>
}
