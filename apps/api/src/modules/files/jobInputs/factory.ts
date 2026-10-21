import type pg from 'pg'
import type { PostgresJobDispatch } from '../../jobs/dispatch.js'
import type { DeviceEndpoint } from '../../devices/deviceEndpoint.js'
import { FileByteStorage } from '../storage.js'
import { MAX_FILE_BYTES } from '@foreman-code/contracts/files'
import { JobInputAuthority } from './authority.js'
import { CanonicalJobInputs } from './service.js'
import { ReadonlyJobInputDelivery, type JobSystemInput } from './delivery.js'
import { jobInputDeviceExtension } from './channel.js'
/** Actual existing canonical store/ownership/preparation/W07 services; no worker DB handle or caller bytes. */
export function createCanonicalJobInputPorts(input:{pool:pg.Pool;storageRoot:string;runtime:PostgresJobDispatch;endpoint:Pick<DeviceEndpoint,'currentBinding'>;receiptRoot:string;systemInput?:JobSystemInput;clock?:()=>Date}){
  const authority=new JobInputAuthority(input.pool,input.runtime,input.clock)
  const main=new CanonicalJobInputs(input.pool,authority,new FileByteStorage(input.storageRoot,MAX_FILE_BYTES),input.endpoint,input.clock)
  const local = new ReadonlyJobInputDelivery({
    admit: (execution, signal, context) => { signal.throwIfAborted(); return main.bind(execution, context) },
    accepted: async (execution, signal) => { signal.throwIfAborted(); return (await main.accepted(execution.id)).admission },
    recheck: (execution, admission, signal) => { signal.throwIfAborted(); return main.recheck(execution, admission) },
    openRead: (execution, admission, path, signal) => main.openRead(execution, admission, path, signal),
    read: (execution, admission, path, offset, length, signal) => {
      signal.throwIfAborted(); return main.read(execution, admission, path, offset, length)
    },
  }, input.receiptRoot, input.systemInput)
  return {main,local,extension:jobInputDeviceExtension(main),validateDeclaredJobInputs:authority.validateDeclaredJobInputs.bind(authority)}
}
export { createWorkerJobInputPort } from './workerFactory.js'
