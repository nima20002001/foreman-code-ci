import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'

import { CodexFileTurn } from '../src/modules/harnesses/codexFiles/turn.js'
import { fileToolFixture } from './support/fileTools.js'
const now='2026-01-01T00:00:00.000Z',ref={fileId:'job-file',revisionId:'job-revision'},bytes=Buffer.from('<html>output</html>')
const job={file:{fileId:ref.fileId,currentRevisionId:ref.revisionId,scope:{kind:'job_execution' as const,workspaceId:'workspace-a',jobExecutionId:'job-real'},state:'ready' as const,createdAt:now,retentionDurationSeconds:3600,expiresAt:'2026-01-01T01:00:00.000Z'},
  revision:{...ref,byteClass:'ci-output' as const,filename:'index.html',mediaType:'text/html' as const,origin:'job_output' as const,createdAt:now,sha256:createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length}}
describe('CI artifact/document native isolation',()=>{

  it('denies job scope to conversation list/read and cannot materialize it in an admitted Codex turn',async()=>{
    const f=await fileToolFixture()
    f.repository.values.set(ref.fileId,{value:job,storageKey:'unopened',ownerPrincipalId:f.principal.id})
    const downloads=f.bytes.downloads
    await expect(f.service.list(f.token,{scope:job.file.scope})).rejects.toMatchObject({code:'FILE_UNAVAILABLE'})
    expect(await f.service.read(f.token,{...ref,offset:0,length:1})).toMatchObject({status:'unavailable',reason:'forbidden'})
    expect(f.bytes.downloads).toBe(downloads)
    const materialize=vi.fn(),open=vi.fn(async()=>({value:job,stream:Readable.from([bytes])}))
    const accepted={ownerPrincipalId:f.principal.id,scope:f.scope,nativeSessionId:'native',admissionId:'admission',messageId:'message',executionHostId:'host',
      projectMode:'read' as const,allowMutation:false,allowedTools:['files.read' as const],expiresAt:new Date('2026-01-01T00:30:00Z'),attachments:[ref]}
    await expect(CodexFileTurn.prepare(accepted,{source:{open,recheck:async()=>job},
      host:{materialize,executionHostId:'host',pathStyle:'posix',close:async()=>{}},clock:()=>new Date(now),limits:{fileBytes:4096,readBytes:1024,attachments:1},files:{}} as never)).rejects.toThrow('CODEX_FILE_DOCUMENT_REQUIRED')
    expect(open).toHaveBeenCalledTimes(1)
    expect(materialize).not.toHaveBeenCalled()
  })
  it('denies an uploaded foreign-conversation document before materialization',async()=>{
    const f=await fileToolFixture(),document=await f.upload('# foreign document',f.foreign)
    const stored=await f.repository.read(document.fileId,document.revisionId)
    expect(stored!.value.revision).toMatchObject({origin:'upload',mediaType:'text/markdown'})
    const stream=await f.bytes.download(stored!.storageKey!,stored!.value.revision)
    const materialize=vi.fn(async()=>{throw new Error('Denied document must not be materialized.')})
    const open=vi.fn(async()=>({value:stored!.value,stream})),recheck=vi.fn(async()=>stored!.value)
    const accepted={ownerPrincipalId:f.principal.id,scope:f.scope,nativeSessionId:'native',admissionId:'admission',messageId:'message',executionHostId:'host',
      projectMode:'read' as const,allowMutation:false,allowedTools:['files.read' as const],expiresAt:new Date('2026-01-01T00:30:00Z'),attachments:[document]}
    await expect(CodexFileTurn.prepare(accepted,{source:{open,recheck},
      host:{materialize,executionHostId:'host',pathStyle:'posix',sealCompleted:async()=>{throw new Error('Denied document must not be sealed.')},close:async()=>{}},
      clock:()=>new Date(now),limits:{fileBytes:4096,readBytes:1024,attachments:1},files:f.service,parseRead:vi.fn(),parseCall:vi.fn()})).rejects.toThrow('CODEX_FILE_SCOPE_INVALID')
    expect(open).toHaveBeenCalledTimes(1)
    expect(materialize).not.toHaveBeenCalled()
    expect(recheck).not.toHaveBeenCalled()
    expect(stream.destroyed).toBe(true)
  })
})
