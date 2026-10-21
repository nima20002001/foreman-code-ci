import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import { AgentNodeView } from '../../shared/ui/nocturne'
import { AgentHandles } from './AgentHandles'
import type { JobGraphNode } from './types'
/** Shared canvas geometry, with an actual job identity and no native Agent session. */
export const JobNode=memo(function JobNode({data,selected}:NodeProps<JobGraphNode>) {
  return <AgentNodeView name={data.label} harnessLabel="Job" statusLabel="Saved job" selected={selected}
    ariaLabel={`${data.label}, job, saved revision ${data.jobDefinitionRevision}`} onSelect={()=>data.onOpen?.(data.workflowNodeId)}>
    <AgentHandles name={data.label}/>
  </AgentNodeView>
})
