import pg from 'pg'
import { ExclusiveGraphConnection, assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { ignoreError } from '../diagnostics/ignoredError.js'
const JOB_OWNER_NAMESPACE=810038
/** Same PostgreSQL session-lock authority primitive as Runs, with a real job namespace.
 * This acquires no scheduling capability and never fabricates a Run identity. */
export class JobOwnership {
  private lost=false
  private released=false
  readonly connection:ExclusiveGraphConnection
  private constructor(private readonly client:pg.Client,readonly executionId:string,private readonly onLost:()=>void) {
    this.connection=new ExclusiveGraphConnection(client,()=>this.assertOwned())
  }
  static async acquire(pool:pg.Pool,executionId:string,onLost:()=>void):Promise<JobOwnership|undefined> {
    const client=new pg.Client({...pool.options,application_name:'graphql-job-owner'})
    const owner=new JobOwnership(client,executionId,onLost)
    client.on('error',owner.handleLoss);client.on('end',owner.handleLoss)
    try {
      await client.connect()
      const result=await client.query<{acquired:boolean}>('select pg_try_advisory_lock($1,hashtext($2)) as acquired',[JOB_OWNER_NAMESPACE,executionId])
      if(result.rows[0]?.acquired) return owner
      await owner.release();return undefined
    } catch(error) {await owner.release();throw error}
  }
  private readonly handleLoss=()=>{if(this.lost||this.released)return;this.lost=true;this.onLost()}
  assertOwned():void {if(this.lost||this.released)throw new DomainError('JOB_OWNERSHIP_LOST','The main job-owner session disconnected; reconcile the original execution.',409)}
  async readFence(sql:GraphTransactionSql):Promise<{ownerId:string;fence:string}> {
    assertGraphTransaction(sql);this.assertOwned()
    const row=(await sql.query<{owner_id:string;fence:string}>(`select pg_backend_pid()::text owner_id,
      (extract(epoch from a.backend_start)*1000000)::bigint::text fence from pg_stat_activity a
      where a.pid=pg_backend_pid() and exists(select 1 from pg_locks l where l.pid=a.pid and l.locktype='advisory'
        and l.classid=$1::oid and l.objid=(hashtext($2)::bigint & 4294967295)::oid and l.objsubid=2 and l.mode='ExclusiveLock' and l.granted)`,[JOB_OWNER_NAMESPACE,this.executionId])).rows[0]
    if(!row)throw new DomainError('JOB_OWNERSHIP_LOST','The current session does not hold this job lock.',409)
    return {ownerId:row.owner_id,fence:row.fence}
  }
  async release():Promise<void> {
    if(this.released)return;this.released=true
    try {await this.connection.close()} finally {await this.client.end().catch(ignoreError('jobs', 'close job ownership client', { executionId: this.executionId }));this.client.removeListener('error',this.handleLoss);this.client.removeListener('end',this.handleLoss)}
  }
}
