import { isDeepStrictEqual } from 'node:util'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { ImmutableTransferSource } from '../../byte-transfer/sender.js'
import { DomainError } from '../../errors.js'
import type { CanonicalJobInputs } from './service.js'

/** Reads only the original canonical admission, pins and FileByteStorage reader. */
export class CanonicalJobInputRsyncSource implements ImmutableTransferSource {
  constructor(private readonly canonical:Pick<CanonicalJobInputs,'acceptedTransfer'|'read'>) {}
  async intentForTransfer(transferId:string):Promise<TransferIntent> {
    return (await this.canonical.acceptedTransfer(transferId)).transfer.intent
  }
  async read(intent:TransferIntent,offset:number,length:number,signal?:AbortSignal):Promise<Uint8Array> {
    signal?.throwIfAborted()
    const {execution,admission,transfer}=await this.canonical.acceptedTransfer(intent.transferId)
    if(!isDeepStrictEqual(transfer.intent,intent))throw new DomainError('JOB_INPUT_TRANSFER_DENIED','Only the exact original canonical input may be read.',403)
    const bytes=await this.canonical.read(execution,admission,transfer.relativePath,offset,length)
    signal?.throwIfAborted()
    return bytes
  }
}
