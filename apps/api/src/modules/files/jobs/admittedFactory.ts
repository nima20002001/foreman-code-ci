import type pg from 'pg'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import { ResumableByteTransferService } from '../../byte-transfer/service.js'
import { createCanonicalJobArtifactPort } from './factory.js'
import { PostgresJobOutputAdmission } from './outputAdmission.js'
import { VerifiedJobOutputReader } from './transferReader.js'
import { jobOutputDeviceExtension } from './outputChannel.js'
import { PostgresJobPublicationLedger } from './ledger.js'
import { JobOutputRsyncLifecycle } from './rsyncLifecycle.js'
import type { TrustedJobOutputReader } from './port.js'
import { createMainJobOutputRsyncExtension, type MainJobOutputRsyncPorts } from './rsyncProduction.js'

/** Complete main admission/receiver/resolver/canonical publication composition. No permissive hooks. */
export function createAdmittedJobOutputs(input: {pool:pg.Pool;storageRoot:string;stagingRoot:string;
  endpoint:Pick<DeviceEndpoint,'currentBinding'>;authority:JobPublicationAuthority;excludedRoots?:readonly string[];clock?:()=>Date;
  receiver?:ResumableByteTransferService;reader?:TrustedJobOutputReader;rsync?:MainJobOutputRsyncPorts}) {
  const admission=new PostgresJobOutputAdmission(input.pool,input.authority,input.endpoint,(request,source)=>artifacts.reserveAccepted(request,source),input.clock)
  const receiver=input.receiver??new ResumableByteTransferService(input.stagingRoot,{authorize:(intent,context)=>admission.authorizeTransfer(intent,context)},()=>input.clock?.().getTime()??Date.now())
  const artifacts=createCanonicalJobArtifactPort({pool:input.pool,storageRoot:input.storageRoot,
    ...(input.excludedRoots?{excludedRoots:input.excludedRoots}:{}),...(input.clock?{clock:input.clock}:{}),
    authority: { authorizePublication: async (sql, request) => {
      const actual = await input.authority.authorizePublication(sql, request)
      if (actual.execution.acceptedSpec.target.hostRef.kind === 'device') {
        await admission.assertContext(sql, request, actual.execution)
      }
      return actual
    } },
    reader:input.reader??new VerifiedJobOutputReader(receiver,admission)})
  const lifecycle=new JobOutputRsyncLifecycle(input.pool,admission,new PostgresJobPublicationLedger(input.pool),input.clock)
  const extension=createMainJobOutputRsyncExtension(admission,lifecycle,jobOutputDeviceExtension(admission,artifacts,receiver),input.rsync)
  return {admission,receiver,artifacts,lifecycle,extension,async ownsTransfer(transferId:string){
    const result=await input.pool.query(`select 1 from management_command_receipts where operation='job.output.admit' and result #>> '{intent,transferId}'=$1`,[transferId])
    return result.rows.length>0
  },async close(){if(!input.receiver)await receiver.close()}}
}
