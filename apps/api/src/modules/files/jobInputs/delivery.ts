import { constants } from 'node:fs'
import { open, mkdir, readFile, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, relative, isAbsolute } from 'node:path'
import {
  JOB_INPUT_DIRECTORY,
  JobInputDeliveryReceiptSchema,
  JobInputAdmissionSchema,
  type JobInputAdmission,
  type JobInputDeliveryReceipt,
} from '@foreman-code/contracts/job-inputs'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { DomainError } from '../../errors.js'
import { inputHash, recipient, snapshotDigest, verificationContextPin } from './manifest.js'
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
async function identity(handle:FileHandle){const stat=await handle.stat(),info=await readFile(`/proc/self/fdinfo/${handle.fd}`,'utf8'),mountId=/^mnt_id:\s*(\d+)$/m.exec(info)?.[1];if(!mountId)throw new Error('Input destination mount identity is unavailable.');return {device:String(stat.dev),inode:String(stat.ino),mountId}}
async function directory(path:string){const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isDirectory()||(process.getuid&&stat.uid!==process.getuid())){await handle.close();throw new Error('Input destination must be an owned directory.')}return handle}
export interface JobInputDeliverySource {
  admit(execution:JobExecutionRecord,signal:AbortSignal,verificationContext?:JobInputAdmission['manifest']['verificationContext']):Promise<JobInputAdmission>
  /** Reads and reauthorizes the original admission without staging or starting transfers. */
  accepted?(execution:JobExecutionRecord,signal:AbortSignal):Promise<JobInputAdmission>
  recheck(execution:JobExecutionRecord,admission:JobInputAdmission,signal:AbortSignal):Promise<void>
  openRead?(execution: JobExecutionRecord, admission: JobInputAdmission, path: string, signal: AbortSignal):
    Promise<{ read(offset: number, length: number): Promise<Uint8Array>; close(): Promise<void> }>
  read(execution:JobExecutionRecord,admission:JobInputAdmission,path:string,offset:number,length:number,signal:AbortSignal):Promise<Uint8Array>
}
export interface VerifiedJobInputDeliverySource {
  privateRepositoryRoot:string
  directoryIdentityHash:string
  privateGit:true
  gitMounts?: import('../../jobs/privateGitMounts.js').VerifiedJobGitMounts
  diskQuotaBytes:number
}
export type JobSystemInput = (execution: JobExecutionRecord, source: VerifiedJobInputDeliverySource,
  signal: AbortSignal) => Promise<JobInputAdmission['manifest']['verificationContext']>
async function readReceipt(path:string):Promise<JobInputDeliveryReceipt>{
  const record=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
  try{const stat=await record.stat();if(!stat.isFile()||stat.size>1024*1024||(process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0)throw new Error('Invalid private input receipt.');return JobInputDeliveryReceiptSchema.parse(JSON.parse(await record.readFile('utf8')))}finally{await record.close()}
}
async function verifyRetained(root:FileHandle,execution:JobExecutionRecord,admission:JobInputAdmission,original:JobInputDeliveryReceipt,signal:AbortSignal){
  if(inputHash(original.recipient)!==inputHash(recipient(execution))||original.bindingId!==admission.manifest.bindingId||original.inputSnapshotDigest!==snapshotDigest(execution)||original.manifestSha256!==admission.manifest.manifestSha256||original.manifestByteSize!==admission.manifest.manifestByteSize)throw new DomainError('JOB_INPUT_RECEIPT_CONFLICT','Existing detached input receipt belongs to different accepted data.',409)
  const expectedFiles=[{relativePath:'manifest.json',sha256:admission.manifest.manifestSha256,byteSize:admission.manifest.manifestByteSize},{relativePath:'workflow-input.json',sha256:hash(Buffer.from(JSON.stringify(admission.manifest.workflowInput))),byteSize:Buffer.byteLength(JSON.stringify(admission.manifest.workflowInput))},...admission.manifest.entries.map(entry=>({relativePath:entry.relativePath,sha256:entry.pin.sha256,byteSize:entry.pin.byteSize}))]
  if(inputHash(original.files)!==inputHash(expectedFiles)||inputHash(original.verificationContext??null)!==inputHash(verificationContextPin(admission.manifest)??null))throw new DomainError('JOB_INPUT_RECEIPT_CONFLICT','Receipt no longer describes the complete original manifest.',409)
  const retained=await directory(`/proc/self/fd/${root.fd}/${JOB_INPUT_DIRECTORY}`)
  try{
    const rootIdentity=await identity(root),retainedIdentity=await identity(retained)
    if(inputHash({...retainedIdentity,relativePath:JOB_INPUT_DIRECTORY})!==inputHash(original.directory)||retainedIdentity.device!==rootIdentity.device||retainedIdentity.mountId!==rootIdentity.mountId)throw new DomainError('JOB_INPUT_DIRECTORY_CONFLICT','Original input directory identity changed.',409)
    for(const file of original.verificationContext?[...original.files,original.verificationContext]:original.files){
      signal.throwIfAborted();let parent=retained;const held:FileHandle[]=[]
      try{const parts=file.relativePath.split('/');for(const part of parts.slice(0,-1)){const next=await directory(`/proc/self/fd/${parent.fd}/${part}`);const current=await identity(next);if(current.device!==original.directory.device||current.mountId!==original.directory.mountId){await next.close();throw new Error('Retained inputs crossed the approved volume.')}held.push(next);parent=next}
        const handle=await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`,constants.O_RDONLY|constants.O_NOFOLLOW)
        try{const stat=await handle.stat(),current=await identity(handle);if(!stat.isFile()||stat.size!==file.byteSize)throw new Error('Retained input object differs from receipt.');if(current.device!==original.directory.device||current.mountId!==original.directory.mountId)throw new Error('Retained inputs crossed the approved volume.');const checksum=createHash('sha256'),buffer=Buffer.alloc(8192);let offset=0;while(offset<stat.size){signal.throwIfAborted();const data=await handle.read(buffer,0,Math.min(8192,stat.size-offset),offset);if(!data.bytesRead)throw new Error('Retained input is truncated.');checksum.update(buffer.subarray(0,data.bytesRead));offset+=data.bytesRead}if(checksum.digest('hex')!==file.sha256)throw new Error('Retained input hash differs from receipt.')}finally{await handle.close()}
      }finally{for(const item of held.reverse())await item.close()}
    }
  }finally{await retained.close()}
}
/** Detached copies on the already verified original private worktree. Read-only OCI bind is mandatory. */
export class ReadonlyJobInputDelivery {
  constructor(private readonly source:JobInputDeliverySource,private readonly receiptRoot:string,
    private readonly systemInput?: JobSystemInput){}
  /** Verifies the original detached delivery without creating files or reading transfer bytes. */
  async verifyPrepared(execution:JobExecutionRecord,verifiedOriginalSource:VerifiedJobInputDeliverySource,originalReceipt:JobInputDeliveryReceipt,signal:AbortSignal):Promise<JobInputDeliveryReceipt>{
    signal.throwIfAborted()
    if(resolve(verifiedOriginalSource.privateRepositoryRoot)!==execution.acceptedSpec.target.destination.canonicalProjectRoot||verifiedOriginalSource.directoryIdentityHash!==execution.acceptedSpec.target.destination.directoryIdentityHash||!verifiedOriginalSource.privateGit)throw new DomainError('JOB_INPUT_DESTINATION_CONFLICT','Input delivery requires the exact previously verified private source.',409)
    if(!this.source.accepted)throw new DomainError('JOB_INPUT_ADMISSION_UNAVAILABLE','Read-only original input admission is unavailable.',410)
    const original=JobInputDeliveryReceiptSchema.parse(originalReceipt),admission=JobInputAdmissionSchema.parse(await this.source.accepted(execution,signal))
    if(inputHash(recipient(execution))!==inputHash(admission.manifest.recipient)||snapshotDigest(execution)!==admission.manifest.inputSnapshotDigest)throw new DomainError('JOB_INPUT_SNAPSHOT_CONFLICT','Delivery cannot replace accepted job input.',409)
    if(admission.manifest.totalBytes+admission.manifest.manifestByteSize+Buffer.byteLength(JSON.stringify(admission.manifest.workflowInput))>verifiedOriginalSource.diskQuotaBytes)throw new DomainError('JOB_INPUT_DISK_BUDGET','Input delivery exceeds the qualified private volume budget.',413)
    const root=await directory(verifiedOriginalSource.privateRepositoryRoot)
    let receipts:FileHandle|undefined
    try{
      if(hash(Buffer.from(JSON.stringify(await identity(root))))!==verifiedOriginalSource.directoryIdentityHash)throw new DomainError('JOB_INPUT_DESTINATION_CONFLICT','Actual private source identity differs from the accepted verification.',409)
      signal.throwIfAborted();await this.source.recheck(execution,admission,signal)
      const suffix=relative(resolve(verifiedOriginalSource.privateRepositoryRoot),resolve(this.receiptRoot))
      if(!isAbsolute(this.receiptRoot)||suffix===''||(!suffix.startsWith('..')&&!isAbsolute(suffix)))throw new Error('Input receipts must remain outside the build source/mount.')
      let anchor=await open('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
      try{for(const segment of resolve(this.receiptRoot).split('/').filter(Boolean)){const next=await open(`/proc/self/fd/${anchor.fd}/${segment}`,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);await anchor.close();anchor=next}receipts=anchor}catch(error){await anchor.close();throw error}
      const stat=await receipts.stat();if((process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0)throw new Error('Input receipts require a private owned directory.')
      const persisted=await readReceipt(`/proc/self/fd/${receipts.fd}/${admission.manifest.bindingId}.json`)
      if(inputHash(persisted)!==inputHash(original))throw new DomainError('JOB_INPUT_RECEIPT_CONFLICT','Prepared receipt differs from the original private receipt.',409)
      await verifyRetained(root,execution,admission,original,signal)
      await this.source.recheck(execution,admission,signal);signal.throwIfAborted();return original
    }finally{await receipts?.close();await root.close()}
  }
  async prepare(execution:JobExecutionRecord,verified:VerifiedJobInputDeliverySource,signal:AbortSignal):Promise<JobInputDeliveryReceipt>{
    signal.throwIfAborted()
    if(resolve(verified.privateRepositoryRoot)!==execution.acceptedSpec.target.destination.canonicalProjectRoot||verified.directoryIdentityHash!==execution.acceptedSpec.target.destination.directoryIdentityHash||!verified.privateGit)throw new DomainError('JOB_INPUT_DESTINATION_CONFLICT','Input delivery requires the exact previously verified private source.',409)
    const admission=JobInputAdmissionSchema.parse(await this.source.admit(execution,signal,await this.systemInput?.(execution,verified,signal)))
    signal.throwIfAborted()
    if(inputHash(recipient(execution))!==inputHash(admission.manifest.recipient)||snapshotDigest(execution)!==admission.manifest.inputSnapshotDigest)throw new DomainError('JOB_INPUT_SNAPSHOT_CONFLICT','Delivery cannot replace accepted job input.',409)
    if(admission.manifest.totalBytes+admission.manifest.manifestByteSize+Buffer.byteLength(JSON.stringify(admission.manifest.workflowInput))>verified.diskQuotaBytes)throw new DomainError('JOB_INPUT_DISK_BUDGET','Input delivery exceeds the qualified private volume budget.',413)
    const root=await directory(verified.privateRepositoryRoot),rootIdentity=await identity(root)
    if(hash(Buffer.from(JSON.stringify(rootIdentity)))!==verified.directoryIdentityHash){await root.close();throw new DomainError('JOB_INPUT_DESTINATION_CONFLICT','Actual private source identity differs from the accepted verification.',409)}
    let target:FileHandle|undefined,receipts:FileHandle|undefined
    try{
      signal.throwIfAborted();await this.source.recheck(execution,admission,signal)
      const suffix=relative(resolve(verified.privateRepositoryRoot),resolve(this.receiptRoot))
      if(!isAbsolute(this.receiptRoot)||suffix===''||(!suffix.startsWith('..')&&!isAbsolute(suffix)))throw new Error('Input receipts must remain outside the build source/mount.')
      const segments=resolve(this.receiptRoot).split('/').filter(Boolean);let anchor=await open('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{for(const segment of segments){const child=`/proc/self/fd/${anchor.fd}/${segment}`;await mkdir(child,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error});const next=await open(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);await anchor.close();anchor=next}receipts=anchor;const stat=await receipts.stat();if((process.getuid&&stat.uid!==process.getuid())||(stat.mode&0o077)!==0)throw new Error('Input receipts require a private owned directory.')}catch(error){await anchor.close();throw error}
      const receiptPath=`/proc/self/fd/${receipts.fd}/${admission.manifest.bindingId}.json`
      const path=`/proc/self/fd/${root.fd}/${JOB_INPUT_DIRECTORY}`
      let original:JobInputDeliveryReceipt|undefined
      try{original=await readReceipt(receiptPath)}catch(error){if((error as {code?:string}).code!=='ENOENT')throw error}
      if(original){
        await verifyRetained(root,execution,admission,original,signal)
        await this.source.recheck(execution,admission,signal);signal.throwIfAborted();return original
      }

      // An accepted source tree cannot provide/overwrite the reserved input namespace.
      try{await mkdir(path,{mode:0o700})}catch(error){if((error as {code?:string}).code==='EEXIST')throw new DomainError('JOB_INPUT_DIRECTORY_CONFLICT','The reserved input directory already exists; verify its original receipt before retry.',409, undefined, { cause: error });throw error}
      target=await directory(path);const destination=await identity(target),files:JobInputDeliveryReceipt['files']=[]
      const descriptors=[{relativePath:'manifest.json',sha256:admission.manifest.manifestSha256,byteSize:admission.manifest.manifestByteSize},
        {relativePath:'workflow-input.json',sha256:hash(Buffer.from(JSON.stringify(admission.manifest.workflowInput))),byteSize:Buffer.byteLength(JSON.stringify(admission.manifest.workflowInput))},
        ...admission.manifest.entries.map(entry=>({relativePath:entry.relativePath,sha256:entry.pin.sha256,byteSize:entry.pin.byteSize})),
        ...(verificationContextPin(admission.manifest)?[verificationContextPin(admission.manifest)!]:[])]
      for(const descriptor of descriptors){
        signal.throwIfAborted();const parts=descriptor.relativePath.split('/')
        if(parts.some(part=>!part||part==='.'||part==='..'||part.includes('\\')))throw new DomainError('JOB_INPUT_PATH_CONFLICT','Input paths must be bounded relative paths.',409)
        let parent=target;const owned:FileHandle[]=[]
        try{
          for(const part of parts.slice(0,-1)){const child=`/proc/self/fd/${parent.fd}/${part}`;await mkdir(child,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error});const next=await directory(child);const id=await identity(next);if(id.mountId!==destination.mountId||id.device!==destination.device){await next.close();throw new Error('Input directory crossed its approved volume.')}owned.push(next);parent=next}
          const handle=await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)}`,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o400),checksum=createHash('sha256')
          let reader: Awaited<ReturnType<NonNullable<JobInputDeliverySource['openRead']>>> | undefined
          try{
            reader = await this.source.openRead?.(execution, admission, descriptor.relativePath, signal)
            for (let offset = 0; offset < descriptor.byteSize; offset += 8192) {
              signal.throwIfAborted()
              const length = Math.min(8192, descriptor.byteSize - offset)
              const range = reader ? await reader.read(offset, length)
                : await this.source.read(execution, admission, descriptor.relativePath, offset, length, signal)
              signal.throwIfAborted()
              const bytes = Buffer.from(range)
              if (bytes.length !== length) {
                throw new DomainError('JOB_INPUT_BYTES_UNAVAILABLE', 'Input stream ended before its exact pins.', 410)
              }
              checksum.update(bytes)
              let written = 0
              while (written < bytes.length) {
                signal.throwIfAborted()
                const output = await handle.write(bytes, written, bytes.length - written, offset + written)
                if (!output.bytesWritten) throw new Error('Input storage made no progress.')
                written += output.bytesWritten
              }
            }
            if (checksum.digest('hex') !== descriptor.sha256) {
              throw new DomainError('JOB_INPUT_HASH_CONFLICT', 'Delivered bytes differ from the immutable accepted pins.', 410)
            }
            signal.throwIfAborted()
            await handle.sync()
          } finally {
            try { await reader?.close() }
            finally { await handle.close() }
          }
          await parent.sync();if(descriptor.relativePath!=='verification.json')files.push(descriptor)
        }finally{for(const handle of owned.reverse())await handle.close()}
      }
      await this.source.recheck(execution,admission,signal)
      signal.throwIfAborted()
      if(inputHash(await identity(root))!==inputHash(rootIdentity))throw new DomainError('JOB_INPUT_DESTINATION_CONFLICT','Private source identity changed during delivery.',409)
      const receipt=JobInputDeliveryReceiptSchema.parse({version:1,recipient:recipient(execution),bindingId:admission.manifest.bindingId,inputSnapshotDigest:admission.manifest.inputSnapshotDigest,manifestSha256:admission.manifest.manifestSha256,manifestByteSize:admission.manifest.manifestByteSize,directory:{relativePath:JOB_INPUT_DIRECTORY,...destination},files,
        ...(verificationContextPin(admission.manifest)?{verificationContext:verificationContextPin(admission.manifest)}:{}),readonlyMountRequired:true})
      const record=await open(receiptPath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o400);try{await record.writeFile(JSON.stringify(receipt));await record.sync()}finally{await record.close()}
      await target.chmod(0o500);await target.sync();await root.sync();await receipts.sync();return receipt
    }finally{await receipts?.close();await target?.close();await root.close()}
  }
}
