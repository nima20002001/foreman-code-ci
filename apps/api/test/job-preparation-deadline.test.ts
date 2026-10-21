import { describe,expect,it,vi } from 'vitest'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { requireJobPreparationDeadline } from '../src/modules/jobs/preparationDeadline.js'
describe('final actual source preparation deadline',()=>{
  it.each(['manual','workflow'] as const)('denies %s acceptance after the original durable preparation budget',async kind=>{
    const query=vi.fn(async()=>({rows:[{created_at:new Date(1000)}],rowCount:1,command:'SELECT',oid:0,fields:[]}))
    await expect(requireJobPreparationDeadline({query:query as JobSql['query']},kind,'real-preparation',1000,2000)).rejects.toMatchObject({code:'JOB_PREPARATION_TIMEOUT'})
    expect(query).toHaveBeenCalledWith(expect.stringContaining(kind==='manual'?'job_preparations':'workflow_job_preparations'),['real-preparation'])
  })
  it('does not infer a preparation start from absent bookkeeping',async()=>{
    const query=vi.fn(async()=>({rows:[],rowCount:0,command:'SELECT',oid:0,fields:[]}))
    await expect(requireJobPreparationDeadline({query:query as JobSql['query']},'manual','missing',1000,2000)).rejects.toMatchObject({code:'JOB_PREPARATION_MISSING'})
  })
})
