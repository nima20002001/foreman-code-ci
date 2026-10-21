import { describe, expect, it } from 'vitest'
import {
  AgentCreateInputSchema, AgentUpdateInputSchema, GraphDraftOperationSchema,
  LocationProvisionInputSchema, RunRetryInputSchema,
  WorkflowTriggerUpdateInputSchema,
} from '../src/management/index.js'

const configuration = {harness:'codex',model:'fixture',reasoningEffort:'low',sandbox:'read-only',serviceTier:'standard'} as const
const commandId = 'comprehensive-command'

describe('management extension contracts', () => {
  it('defaults new standalone Agents to coder, not Operator authority', () => {
    const input={workspaceId:'w',agentId:'a',name:'Agent',commandId,configuration}
    expect(AgentCreateInputSchema.parse(input).productRole).toBe('coder')
    expect(AgentCreateInputSchema.safeParse({...input,productRole:'operator'}).success).toBe(false)
  })
  it('does not allow arbitrary native settings or operational state in creation', () => {
    const input={workspaceId:'w',agentId:'a',name:'Agent',commandId,configuration}
    expect(AgentCreateInputSchema.safeParse({...input,activeRunId:'run'}).success).toBe(false)
    expect(AgentCreateInputSchema.safeParse({...input,configuration:{...configuration,unknownFlag:true}}).success).toBe(false)
  })
  it('requires both the metadata revision and current configuration pin for standalone changes', () => {
    const input={workspaceId:'w',agentId:'a',commandId,expectedRevision:0,name:'Changed'}
    expect(AgentUpdateInputSchema.safeParse(input).success).toBe(false)
    expect(AgentUpdateInputSchema.safeParse({...input,expectedConfigurationVersionId:'v1'}).success).toBe(true)
    expect(AgentUpdateInputSchema.safeParse({workspaceId:'w',agentId:'a',commandId,expectedRevision:0,expectedConfigurationVersionId:'v1'}).success).toBe(false)
  })
  it('preserves template configuration overrides and rejects conflicting product-role declarations', () => {
    const input={type:'agent.add_from_template',agentId:'a',nodeId:'n',name:'Agent',template:'coder',configuration}
    expect(GraphDraftOperationSchema.parse(input)).toMatchObject({configuration})
    expect(GraphDraftOperationSchema.safeParse({...input,productRole:'orchestrator'}).success).toBe(false)
  })
  it('requires source pins when attaching an existing Agent', () => {
    const input={type:'agent.attach',agentId:'a',nodeId:'n'}
    expect(GraphDraftOperationSchema.safeParse(input).success).toBe(false)
    expect(GraphDraftOperationSchema.safeParse({...input,expectedAgentRevision:0,expectedConfigurationVersionId:'v1'}).success).toBe(true)
  })
  it('exposes typed history restore and execution-condition edits', () => {
    expect(GraphDraftOperationSchema.safeParse({type:'workflow.restore_version',versionId:'v1'}).success).toBe(true)
    expect(GraphDraftOperationSchema.safeParse({type:'workflow.set_execution_condition',executionCondition:{kind:'on_event'}}).success).toBe(true)
  })
  it('does not accept arbitrary host paths in controlled provisioning', () => {
    const input={workspaceId:'w',commandId,expectedLocationRevision:0}
    expect(LocationProvisionInputSchema.safeParse(input).success).toBe(true)
    expect(LocationProvisionInputSchema.safeParse({...input,rootPath:'/etc'}).success).toBe(false)
  })
  it('keeps retry and general-question contracts separate from approval semantics', () => {
    expect(RunRetryInputSchema.safeParse({workspaceId:'w',runId:'r',commandId,workflowVersionId:'v1',expectedLocationRevision:0,nodeId:'n'}).success).toBe(false)
  })
  it('rejects sub-minute schedules and cron-like unimplemented fields', () => {
    const input={workspaceId:'w',workflowId:'f',commandId,expectedRevision:0,workflowVersionId:'v1',expectedLocationRevision:1,enabled:true,
      trigger:{kind:'schedule',startsAt:'2026-09-17T00:00:00Z',intervalSeconds:60}}
    expect(WorkflowTriggerUpdateInputSchema.safeParse(input).success).toBe(true)
    expect(WorkflowTriggerUpdateInputSchema.safeParse({...input,trigger:{...input.trigger,intervalSeconds:59}}).success).toBe(false)
    expect(WorkflowTriggerUpdateInputSchema.safeParse({...input,trigger:{...input.trigger,cron:'* * * * *'}}).success).toBe(false)
  })
})
