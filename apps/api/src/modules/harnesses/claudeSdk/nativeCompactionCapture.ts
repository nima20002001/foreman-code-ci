/** Runs inside the existing native process guardian, before SDK output reaches the API. */
export const CLAUDE_COMPACTION_CAPTURE_SOURCE = String.raw`
function claudeCompactionCapture(scope, onTerminal) {
  if(!scope || ['deviceId','profilePath','configRevision','cwd'].some(key=>typeof scope[key]!=='string')) {
    throw new Error('Invalid Claude compaction scope')
  }
  let pending
  let sessionId
  const buffers={input:'',output:''}
  const skipped={input:false,output:false}
  function line(kind, text) {
    let frame
    try{frame=JSON.parse(text)}catch{return}
    if(kind==='input') {
      if(frame.type==='user' && frame.message?.content==='/compact') {
        if(pending || typeof frame.uuid!=='string' || !/^[a-f0-9-]{36}$/i.test(frame.uuid)) {
          throw new Error('Invalid Claude compact identity')
        }
        pending={uuid:frame.uuid,sessionId,boundary:false}
      }
      return
    }
    if(typeof frame.session_id==='string' && frame.parent_tool_use_id==null) {
      if(sessionId && frame.session_id!==sessionId)throw new Error('Claude session changed')
      sessionId=frame.session_id
    }
    if(!pending || !sessionId || pending.sessionId && pending.sessionId!==sessionId)return
    if(frame.type==='system' && frame.subtype==='compact_boundary' && frame.compact_metadata?.trigger==='manual') {
      pending.boundary=true
    }
    if(frame.type!=='result' || typeof frame.is_error!=='boolean' || frame.parent_tool_use_id!=null
      || frame.deferred_tool_use!=null || ['tool_deferred','background_requested'].includes(frame.terminal_reason))return
    const uuids=Array.isArray(frame.user_message_uuids)?frame.user_message_uuids:[]
    if(typeof frame.user_message_uuid==='string')uuids.push(frame.user_message_uuid)
    if(uuids.some(uuid=>uuid!==pending.uuid))return
    const session={...scope,nativeSessionId:sessionId}
    const hash=createHash('sha256').update(JSON.stringify([session.deviceId,session.profilePath,session.configRevision,session.cwd,session.nativeSessionId])).digest('hex')
    const root=join(scope.profilePath,'foreman-session-controls',hash)
    fs.mkdirSync(root,{recursive:true,mode:0o700})
    const value={scope:hash,promptUuid:pending.uuid,nativeSessionId:sessionId,
      status:frame.is_error?'failed':pending.boundary?'completed':'no-op',observedAt:new Date().toISOString()}
    birth(join(root,pending.uuid+'.json'),value)
    pending=undefined
    onTerminal()
  }
  function consume(kind, chunk) {
    const parts=chunk.toString('utf8').split('\n')
    for(let index=0;index<parts.length;index++) {
      if(!skipped[kind])buffers[kind]+=parts[index]
      if(buffers[kind].length>8*1024*1024){buffers[kind]='';skipped[kind]=true}
      if(index<parts.length-1) {
        if(!skipped[kind])line(kind,buffers[kind])
        buffers[kind]=''
        skipped[kind]=false
      }
    }
  }
  return {consume,pending:()=>Boolean(pending)}
}
`
