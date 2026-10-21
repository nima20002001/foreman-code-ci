import { describe,expect,it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import { workflowJobResult } from '../src/modules/jobs/workflowResult.js'
import { jobExecution } from './helpers/jobFixture.js'
import { workflowJobNodeAction } from '../src/modules/jobs/workflowNode.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
function fixture() {
  const f=makeCurrentWorkflowFixture('job-routing','single'),execution=jobExecution()
  const node=JobWorkflowNodeSchema.parse({kind:'job',id:'build',name:'Build',jobDefinitionId:execution.acceptedSpec.definitionId,jobDefinitionRevision:1,jobDefinitionVersionId:execution.acceptedSpec.definitionVersionId})
  const version={...f.version,entryNodeId:node.id,agentConfigurationVersionIds:{},definition:{...f.version.definition,entryNodeId:node.id,nodes:[node],edges:[]}}
  execution.workspaceId=version.workspaceId;execution.workflow={workflowId:version.workflowId,runId:f.run.id,nodeId:node.id,nodeExecutionId:execution.id}
  execution.process={phase:'terminal',outcome:'build_failed',exitCode:7,signal:null,processStopped:true};execution.finishedAt=execution.createdAt;execution.publication='complete'
  return {version,execution,node,runId:f.run.id}
}
describe('existing workflow job result path',()=>{
  it('preserves exit7 as job truth and fails an unrouted workflow step',()=>{
    const {version,execution}=fixture(),result=workflowJobResult(version,{nodeId:'build',occurrence:null},execution,[])
    expect(result.resolution.value.resolution).toBe('failed');expect(execution.process.exitCode).toBe(7)
    expect(result.resolution.value.execution).toMatchObject({kind:'job',executionId:execution.id})
    expect(result.resolution.value.execution).not.toHaveProperty('agentId')
  })
  it('routes a declared build_failed outcome without claiming process success',()=>{
    const {version,execution,node}=fixture();node.choice={outcomes:[{outcome:'build_failed',target:{kind:'branch_end'}}]}
    const result=workflowJobResult(version,{nodeId:'build',occurrence:null},execution,[])
    expect(result.resolution.value).toMatchObject({resolution:'succeeded',outcome:'build_failed',branchEnded:true})
    expect(result.result.output).toMatchObject({routing:{outcome:'build_failed'},data:{latestDeliverable:{process:{outcome:'build_failed',exitCode:7}}}})
  })
  it('retains the observed build failure when required output publication also failed',()=>{
    const {version,execution,node}=fixture();node.choice={outcomes:[{outcome:'build_failed',target:{kind:'branch_end'}}]}
    execution.publication='failed';execution.resultIssue='missing_output'
    const result=workflowJobResult(version,{nodeId:'build',occurrence:null},execution,[])
    expect(result.resolution.value.outcome).toBe('build_failed')
    expect(result.result.output).toMatchObject({data:{latestDeliverable:{publication:'failed',resultIssue:'missing_output',process:{outcome:'build_failed',exitCode:7}}}})
  })
  it('does not advance before required publication is durable',()=>{
    const {version,execution}=fixture();execution.publication='collecting'
    expect(()=>workflowJobResult(version,{nodeId:'build',occurrence:null},execution,[])).toThrow()
  })
  it('replays an already-resolved node without preparing or observing another execution',async()=>{
    const {version,execution,runId}=fixture();execution.process.outcome='succeeded';execution.process.exitCode=0
    const resolution=workflowJobResult(version,{nodeId:'build',occurrence:null},execution,[]).resolution
    let prepares=0,observes=0
    const action=workflowJobNodeAction({runId,signal:new AbortController().signal,limiter:new ExecutionLimiter(1),driver:{prepare:async()=>{prepares++;throw new Error('Unexpected prep')},observe:async()=>{observes++}},store:{observeJobState:async()=>{throw new Error('Unexpected observation')},prepareJob:async()=>({kind:'resolved',resolution}),admitPreparedJob:async()=>{throw new Error('Unexpected admission')},acceptJobTerminal:async()=>resolution}})
    expect(await action({nodeId:'build',occurrence:null},{runId,occurrences:{},boundaries:{},executionIds:{}})).toMatchObject({executionIds:{build:{executionId:execution.id,occurrenceId:null}}})
    expect(prepares).toBe(0);expect(observes).toBe(0)
  })
})
