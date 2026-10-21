import { useState } from 'react'
import { Button } from '../../../shared/ui/nocturne'
import { AgentConversation } from '../agentChat/AgentConversation'
import type { WorkflowExecutionChatViewProps } from '../../workflow-hierarchy/execution-chat/types'
import { ExecutionChatPanel } from './ExecutionChatPanel'
import { productionExecutionChatSource } from './productionExecutionChatSource'

export function WorkflowExecutionConversation(props: WorkflowExecutionChatViewProps) {
  return <SelectedConversation key={JSON.stringify(props.resolved.target)} {...props} />
}

function SelectedConversation({ resolved, onSelectTarget }: WorkflowExecutionChatViewProps) {
  const [followUp, setFollowUp] = useState(false)
  const target = resolved.target
  if (followUp && target.kind === 'workflow_execution') {
    const context = { ...target.agent, runId: target.execution.runId }
    const selection = { workspaceId: target.agent.workspaceId, workflowId: target.agent.workflowId,
      workflowNodeId: target.agent.workflowNodeId, runId: target.execution.runId, executionId: target.execution.executionId }
    return <>
      <Button onClick={() => setFollowUp(false)}>Back to execution</Button>
      <AgentConversation context={context} selection={selection} name={resolved.agent.displayName} />
    </>
  }
  return <ExecutionChatPanel visible target={target} name={resolved.agent.displayName} source={productionExecutionChatSource}
    onFollowUp={() => setFollowUp(true)} onOpenContinuation={receipt => {
      if (receipt.continuationExecution) onSelectTarget({ kind: 'workflow_execution', agent: target.agent,
        execution: receipt.continuationExecution }, receipt.continuationExecution.workflowVersionId)
    }} />
}
