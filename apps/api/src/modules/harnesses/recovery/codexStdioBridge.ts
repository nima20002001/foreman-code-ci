/** Runs inside the authenticated native guardian, alongside its cgroup boundary. */
export const CODEX_STDIO_BRIDGE_SOURCE = `
function codexStdioBridge(native, environment, released, observerLost) {
  let connection
  let connectionId
  let originalReleased=false
  let output=''
  let input=''
  const requests=new Map()
  let requestBytes=0
  const operations=new Map()
  const settings=Object.create(null)
  const variables={}
  process.stdin.setEncoding('utf8')
  native.stdout.setEncoding('utf8')
  for(const name of ['FOREMAN_CODE_MCP_TOKEN','GRAPHQL_MCP_TOKEN']) {
    if(environment[name])variables[name]=environment[name]
  }
  function forgetRequest(id) {
    const previous=requests.get(id)
    if(previous!==undefined)requestBytes-=Buffer.byteLength(previous)
    requests.delete(id)
  }
  function forward(chunk, source) {
    input+=chunk.toString('utf8')
    if(Buffer.byteLength(input)>4*1024*1024)throw new Error('Native input exceeds frame limit')
    let end
    while((end=input.indexOf('\\n'))>=0) {
      const line=input.slice(0,end)
      input=input.slice(end+1)
      const message=JSON.parse(line)
      if(message.id!==undefined && !message.method)forgetRequest(message.id)
      if(message.id!==undefined && ['thread/start','thread/resume','thread/fork'].includes(message.method)) {
        operations.set(message.id,message.method)
      }
      if(!native.stdin.write(line+'\\n'))source.pause()
    }
  }
  process.stdin.on('data',chunk=>{
    if(!originalReleased && !released())forward(chunk,process.stdin)
  })
  native.stdin.on('drain',()=>{
    if(connection)connection.resume()
    else if(!originalReleased && !released())process.stdin.resume()
  })
  native.stdin.on('error',stop)
  native.stdout.on('data',chunk=>{
    output+=chunk.toString('utf8')
    if(Buffer.byteLength(output)>4*1024*1024)throw new Error('Native output exceeds frame limit')
    let end
    while((end=output.indexOf('\\n'))>=0) {
      const line=output.slice(0,end)
      output=output.slice(end+1)
      let message
      try{message=JSON.parse(line)}catch{message={}} // The adapter validates provider frames.
      if(!message || typeof message!=='object' || Array.isArray(message))message={}
      if(operations.delete(message.id) && message.result?.thread) {
        const result=message.result
        settings[result.thread.id]={model:result.model,reasoningEffort:result.reasoningEffort,
          cwd:result.cwd,approvalPolicy:result.approvalPolicy,approvalsReviewer:result.approvalsReviewer,
          sandbox:result.sandbox,serviceTier:result.serviceTier}
      }
      if(message.method==='serverRequest/resolved')forgetRequest(message.params?.requestId)
      if(message.id!==undefined && message.method) {
        forgetRequest(message.id)
        requests.set(message.id,line)
        requestBytes+=Buffer.byteLength(line)
        if(requests.size>256 || requestBytes>8*1024*1024)throw new Error('Native pending request limit exceeded')
      }
      if(connection) {
        if(!connection.write(line+'\\n'))native.stdout.pause()
      } else if(!originalReleased && !released() && process.connected) {
        if(!process.stdout.write(line+'\\n'))native.stdout.pause()
      }
    }
  })
  process.stdout.on('drain',()=>native.stdout.resume())
  native.stderr.on('data',chunk=>{
    if(!originalReleased && !released() && process.connected)process.stderr.write(chunk)
  })
  return {
    flush:()=>connection?flushOutput(connection):Promise.resolve(),
    environment:()=>variables,
    settings:()=>settings,
    attach(socket,id) {
      if(connection || !released() || input)throw new Error('Native observer is still owned')
      connection=socket
      connectionId=id
      socket.setTimeout(0)
      socket.setEncoding('utf8')
      socket.on('data',chunk=>{if(connection===socket)forward(chunk,socket)})
      socket.on('drain',()=>native.stdout.resume())
      socket.on('close',()=>{
        if(connection===socket) {
          connection=undefined
          connectionId=undefined
          input=''
          observerLost()
          native.stdout.resume()
        }
      })
      for(const line of requests.values())socket.write(line+'\\n')
      socket.resume()
    },
    detach(id) {
      if(connection && connectionId!==id)throw new Error('Native observer identity changed')
      originalReleased=true
      connection?.destroy()
      connection=undefined
      connectionId=undefined
      input=''
      native.stdout.resume()
    }
  }
}
`
