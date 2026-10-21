import { AuthenticatedJobInputSource, type JobInputWorkerChannel } from './channel.js'
import { ReadonlyJobInputDelivery, type JobSystemInput } from './delivery.js'

/** Worker-only canonical input delivery; no Main pool, SQL authority or byte store. */
export function createWorkerJobInputPort(input:{channel:JobInputWorkerChannel;stagingRoot:string;receiptRoot:string;systemInput?:JobSystemInput}){
  const source=new AuthenticatedJobInputSource(input.channel,input.stagingRoot)
  const delivery=new ReadonlyJobInputDelivery(source,input.receiptRoot,input.systemInput)
  return {prepare:delivery.prepare.bind(delivery),verifyPrepared:delivery.verifyPrepared.bind(delivery),close:()=>source.close()}
}
