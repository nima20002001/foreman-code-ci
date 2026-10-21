import { useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { WorkflowExecutionChatSelectionSchema, WorkflowExecutionChatTargetSchema,
  type WorkflowExecutionChatResolution, type WorkflowExecutionChatSelection,
  type WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import { ApiError } from '../../../shared/api/client'
import { useBlockingReadError } from '../../../shared/api/readFailure'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { executionChatReadKey, executionChatScopeKey, executionChatSelectionKey, resolveExecutionChat,
  workflowExecutionChatClient, type WorkflowExecutionChatClient } from './client'
import type { WorkflowExecutionChatSlotSelection, WorkflowExecutionChatViews } from './types'

type Resolved=Extract<WorkflowExecutionChatResolution,{kind:'selected'}>
function isPinned(selection:WorkflowExecutionChatSelection,resolved:Resolved) {
  const target=resolved.target
  return selection.workflowVersionId===resolved.workflowVersionId&&(target.kind==='workflow_execution'
    ? selection.runId===target.execution.runId&&selection.executionId===target.execution.executionId&&!selection.waitingActivationId
    : selection.runId===target.runId&&selection.waitingActivationId===target.waitingActivationId&&!selection.executionId)
}
function boundClient(cache:QueryClient,resolved:Resolved):WorkflowExecutionChatClient {
  const target=resolved.target, scope=target.agent
  const check=(actual:unknown)=>{
    if(canonicalJson(WorkflowExecutionChatTargetSchema.parse(actual))!==canonicalJson(target)) {
      throw new ApiError({code:'TARGET_CHANGED',message:'Select the other execution explicitly before sending to it.'})
    }
  }
  const refresh=()=>Promise.all([
    cache.invalidateQueries({queryKey:executionChatScopeKey(scope),refetchType:'active'}),
    cache.invalidateQueries({queryKey:['workflow-hierarchy',sessionGeneration(),scope.workspaceId,scope.workflowId],refetchType:'active'}),
  ])
  return {
    read:async(input,options)=>{
      check(input.target)
      const result=await workflowExecutionChatClient.read(input,options)
      if(result.messages.some(message=>message.provenance.kind==='consultation'
        &&message.provenance.binding.workflowVersionId!==resolved.workflowVersionId)) {
        throw new ApiError({code:'INVALID_RESPONSE',message:'The native history belongs to another saved workflow version.'})
      }
      return result
    },
    deliver:async(input,options)=>{check(input.target);try{return await workflowExecutionChatClient.deliver(input,options)}finally{await refresh()}},
    stop:async(input,options)=>{check(input.target);try{return await workflowExecutionChatClient.stop(input,options)}finally{await refresh()}},
    cancel:async(input,options)=>{check(input.target);try{return await workflowExecutionChatClient.cancel(input,options)}finally{await refresh()}},
  }
}

/** This adapter mounts only as the selected Agent Chat body. Hidden rails never
 * resolve targets, fetch history or create a native/conversation owner. */
export function WorkflowExecutionChatAdapter({selection:raw,views}:{
  selection:WorkflowExecutionChatSlotSelection;views:WorkflowExecutionChatViews
}) {
  const cache=useQueryClient()
  const {nodeId,onSelectTarget,onSelectRun,...pins}=raw
  const selection=WorkflowExecutionChatSelectionSchema.parse({...pins,workflowNodeId:nodeId})
  const query=useInfiniteQuery({queryKey:executionChatSelectionKey(selection),
    initialPageParam:undefined as string|undefined,
    queryFn:({signal,pageParam})=>resolveExecutionChat({...selection,...(pageParam?{cursor:pageParam}:{})},{signal}),
    getNextPageParam:(page,_pages,_param,params)=>'nextCursor' in page&&page.nextCursor&&!params.includes(page.nextCursor)
      ?page.nextCursor:undefined,
    retry:false,staleTime:Infinity,refetchOnMount:'always',refetchOnWindowFocus:false,refetchOnReconnect:false,maxPages:10,
  })
  const blocked=useBlockingReadError(query)
  const first=blocked?undefined:query.data?.pages[0], resolved=first?.kind==='selected'?first:undefined
  const pinned=!!resolved&&isPinned(selection,resolved)
  useEffect(()=>{
    if(resolved&&!pinned) onSelectTarget(resolved.target,resolved.workflowVersionId)
  },[resolved,pinned,onSelectTarget])
  const client=useMemo(()=>resolved?boundClient(cache,resolved):undefined,[cache,resolved])
  const failure=query.error??blocked
  const error=failure instanceof Error?failure.message:'Chat could not refresh. Your selection has been kept.'
  const retry=<button type="button" onClick={()=>void query.refetch()} disabled={query.isFetching}>Retry</button>
  if(!first) return failure?<div role="alert">{error} {retry}</div>:<p role="status">Loading selected Agent chat…</p>
  const status=query.isError?<div role="alert">{error} {retry}</div>:null
  if(resolved) {
    if(!pinned||!client) return <p role="status">Opening the selected Run target…</p>
    const View=views.ExecutionChat
    return <>{status}<View key={canonicalJson(resolved.target)} selection={selection} resolved={resolved}
      client={client} queryKey={executionChatReadKey(resolved.target)} onSelectTarget={onSelectTarget} onSelectRun={onSelectRun}/></>
  }
  if(first.kind==='outside_run') {
    const View=views.OutsideRunChat
    return <>{status}<View selection={selection} resolved={first} onSelectTarget={onSelectTarget} onSelectRun={onSelectRun}/></>
  }
  if(first.kind==='unavailable') return <>{status}<p role="status">{first.reason==='NO_EXECUTION'
    ?'This saved node has no available execution. Choose a Run to read its history.'
    :first.reason==='NODE_UNAVAILABLE'?'This Agent is not present in the selected saved workflow.':'The selected saved workflow is unavailable.'}</p></>
  return <section aria-label="Select Agent chat target">
    {status}<p>{first.kind==='run_selection_required'?'Choose a Run for this Agent.':'Choose the exact execution to open.'}</p>
    <ul>{query.data?.pages.flatMap(page=>page.kind==='run_selection_required'?page.items.map(item=>
      <li key={item.runId}><button type="button" onClick={()=>onSelectRun(item)}>Run {item.runId}</button></li>)
      :page.kind==='selection_required'?page.items.map(item=>
        <li key={canonicalJson(item.target)}><button type="button" onClick={()=>onSelectTarget(item.target,item.workflowVersionId)}>
          {choiceLabel(item.target)}
        </button></li>):[])}</ul>
    {query.hasNextPage?<button type="button" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>
      {query.isFetchingNextPage?'Loading…':'Load more targets'}</button>:null}
  </section>
}
function choiceLabel(target:WorkflowExecutionChatTarget) {
  return target.kind==='workflow_execution'?`Execution ${target.execution.executionId} · Attempt ${target.execution.attempt}`
    :`Coordinator waiting at ${target.waitingActivationId}`
}

