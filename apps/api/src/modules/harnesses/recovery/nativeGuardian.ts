import { CLAUDE_COMPACTION_CAPTURE_SOURCE } from '../claudeSdk/nativeCompactionCapture.js'
import { CODEX_STDIO_BRIDGE_SOURCE } from './codexStdioBridge.js'
/**
 * A self-contained Node program. Keeping it in the compiled module avoids a
 * missing .js asset when the API runs through Vitest/tsx rather than dist/.
 * No provider arguments, paths or credentials are interpolated into this code;
 * the launching API sends them only through its private IPC channel.
 */
export const NATIVE_GUARDIAN_SOURCE = `
const { spawn } = require('node:child_process')
const { timingSafeEqual, randomUUID, createHash } = require('node:crypto')
const { createServer } = require('node:net')
const { join, dirname, resolve, parse, sep } = require('node:path')
const fs = require('node:fs')

let launchId
// This standalone guardian reports through stderr; it cannot import the API logger.
function warnCleanup(operation, error, context={}, expected=[]) {
  if(expected.includes(error?.code))return
  const message=error instanceof Error?error.message:String(error)
  try {
    fs.writeSync(2,JSON.stringify({level:'warn',component:'harness',module:'nativeGuardian',
      operation,launchId,pid:process.pid,...context,err:{message,code:error?.code}})+'\\n')
  } catch { /* ignore: stderr is unavailable, so reporting its own write failure is impossible. */ }
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed guardian record')
  return value
}
function directory(path) {
  const absolute = resolve(path)
  let part = parse(absolute).root
  for (const item of absolute.slice(part.length).split(sep).filter(Boolean)) {
    part = join(part, item)
    const stat = fs.lstatSync(part)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe guardian directory')
  }
  const stat = fs.lstatSync(absolute)
  if ((stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Nonprivate guardian directory')
  return absolute
}
function record(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Unsafe guardian record')
    return object(JSON.parse(fs.readFileSync(fd,'utf8')))
  } finally { fs.closeSync(fd) }
}
function birth(path, value) {
  const parent = directory(dirname(path))
  const temp = join(parent, '.pending-'+randomUUID())
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600)
  try { fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  try { fs.linkSync(temp,path) } finally { fs.unlinkSync(temp) }
  const dir = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
  try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
}
function identity(pid=process.pid) {
  const value=fs.readFileSync('/proc/'+pid+'/stat','utf8')
  const parts=value.slice(value.lastIndexOf(')')+2).trim().split(/\\s+/)
  if(parts.length<20 || !/^\\d+$/.test(parts[19]))throw new Error('Invalid Linux identity')
  return {pid,startTicks:parts[19],group:Number(parts[2]),session:Number(parts[3]),state:parts[0]}
}
// This child may only launch native code inside an already-delegated cgroup v2
// subtree. No controller, mount, permission, or host-security setting is changed.
function contain(id, dir, owner, boot) {
  const entry=fs.readFileSync('/proc/self/cgroup','utf8').split('\\n').filter(x=>x.startsWith('0::'))
  if(entry.length!==1)throw new Error('Native recovery requires delegated cgroup v2')
  const relative=entry[0].slice(3)
  if(!relative.startsWith('/') || relative.split('/').includes('..'))throw new Error('Unsafe cgroup hierarchy')
  const parent=resolve('/sys/fs/cgroup','.'+relative)
  let current='/sys/fs/cgroup'
  for(const part of parent.slice(current.length).split('/').filter(Boolean)) {
    current=join(current,part)
    const stat=fs.lstatSync(current)
    if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error('Unsafe cgroup directory')
  }
  if(fs.statfsSync(parent).type!==0x63677270)throw new Error('Native recovery requires cgroup v2')
  const path=join(parent,'graphql-native-'+id)
  fs.mkdirSync(path)
  let fd
  try {
    fd=fs.openSync(path,fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
    const stat=fs.fstatSync(fd,{bigint:true})
    // Qualify forced tree cleanup BEFORE native work is allowed to start.
    const kill=fs.openSync('/proc/self/fd/'+fd+'/cgroup.kill',fs.constants.O_WRONLY)
    fs.closeSync(kill)
    const boundary={kind:'cgroup-v2',path,device:stat.dev.toString(),inode:stat.ino.toString()}
    // Journal the empty boundary before entering it, so a crash before birth
    // publication cannot leave an untracked cgroup behind.
    birth(join(dir,'containment.json'),{format:1,id,owner,boot,boundary})
    fs.writeFileSync('/proc/self/fd/'+fd+'/cgroup.procs',String(process.pid))
    containmentFd=fd
    return boundary
  } catch(error) {
    if(fd!==undefined)fs.closeSync(fd)
    try{fs.rmdirSync(path)}catch(cleanupError){warnCleanup('remove failed containment',cleanupError,{launchId:id},['ENOENT'])}
    throw error
  }
}
let containmentFd
${CLAUDE_COMPACTION_CAPTURE_SOURCE}
${CODEX_STDIO_BRIDGE_SOURCE}
let capture
let disconnected=false
let stopping=false,started=false,leader=false,detached=false,detachRecorded=false
let detachOnDisconnect
function killTree() {
  // The cgroup includes detached descendants and is pinned by an open fd.
  if(containmentFd!==undefined) {
    try{fs.writeFileSync('/proc/self/fd/'+containmentFd+'/cgroup.kill','1');return}
    catch(error){warnCleanup('kill native cgroup',error)}
  }
  // A failed boundary kill is never a close certificate. Recovery remains fenced.
  try{process.kill(-process.pid,'SIGKILL')}catch(error){warnCleanup('kill native process group',error,{},['ESRCH'])}
}
function stop() {
  if(stopping)return
  stopping=true
  if(!leader)process.exit(1) // No native child exists before leader qualification.
  try {process.kill(-process.pid,'SIGTERM')}catch(error){warnCleanup('terminate native process group',error,{},['ESRCH'])}
  setTimeout(killTree,1000)
}
function flushOutput(stream) {
  if(stream.destroyed || !stream.writable)return Promise.resolve()
  return new Promise((resolve,reject)=>stream.write('',error=>error?reject(error):resolve()))
}
function stopAfterNativeExit(drained) {
  if(stopping)return // A cancellation already owns its graceful cleanup deadline.
  stopping=true
  if(!leader)process.exit(1)
  // Descendants retaining pipes and consumers that stop reading cannot hold cleanup forever.
  const deadline=setTimeout(killTree,5000)
  drained.then(()=>{clearTimeout(deadline);killTree()},error=>{
    warnCleanup('drain native output',error)
    clearTimeout(deadline)
    killTree()
  })
}
process.on('SIGTERM',stop)
process.on('SIGINT',stop)
process.on('disconnect',()=>{
  disconnected=true
  if(detached)return
  try {
    if(detachOnDisconnect?.())return
  } catch {
    stop()
    return
  }
  if(capture?.pending())setTimeout(stop,120000).unref()
  else stop()
})
function outputError(error) {
  if(capture)return
  if(error.code==='EPIPE') {
    try {
      if(detached || detachOnDisconnect?.())return
    } catch {
      stop()
      return
    }
  }
  stop()
}
process.stdout.on('error',outputError)
process.stderr.on('error',outputError)
process.on('uncaughtException',stop)
process.on('unhandledRejection',stop)
process.on('message',input=>{
  if(started || stopping)return
  started=true
  try {
    const config=object(input)
    if(config.operation!=='start' || typeof config.directory!=='string' || typeof config.binary!=='string'
      || typeof config.cwd!=='string' || !Array.isArray(config.args) || config.args.some(x=>typeof x!=='string'))throw new Error('Invalid launch')
    const environment=object(config.environment)
    if(Object.values(environment).some(x=>x!==undefined && typeof x!=='string'))throw new Error('Invalid environment')
    const dir=directory(config.directory)
    const intent=record(join(dir,'intent.json'))
    launchId=intent.id
    const live=identity()
    const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()
    if(live.group!==process.pid || live.session!==process.pid || intent.boot!==boot
      || typeof intent.id!=='string' || !/^[0-9a-f-]{36}$/.test(intent.id)
      || typeof intent.controlKey!=='string' || !/^[0-9a-f]{64}$/.test(intent.controlKey)
      || typeof intent.owner!=='string')throw new Error('Unverified process generation')
    leader=true
    const certificate={format:1,id:intent.id,owner:intent.owner,boot,guardian:live}
    let provider
    let bridge
    function recordDetachment() {
      if(config.restartDetachable!==true || !provider || stopping)return false
      if(!detachRecorded) {
        birth(join(dir,'restart-detached.json'),
          {...certificate,provider,reconnectableStdio:config.reconnectableStdio===true})
        detachRecorded=true
      }
      return true
    }
    const expected=Buffer.from(intent.controlKey,'hex')
    const server=createServer(socket=>{
      let pending=''
      socket.setTimeout(2000,()=>socket.destroy())
      socket.on('error',()=>socket.destroy())
      socket.on('data',chunk=>{
        pending+=chunk.toString('utf8')
        if(Buffer.byteLength(pending)>4096){socket.destroy();return}
        if(!pending.includes('\\n'))return
        socket.pause()
        try {
          const message=object(JSON.parse(pending.slice(0,pending.indexOf('\\n'))))
          const supplied=typeof message.controlKey==='string' && /^[0-9a-f]{64}$/.test(message.controlKey)?Buffer.from(message.controlKey,'hex'):Buffer.alloc(0)
          if(!['stop','detach','attach','environment'].includes(message.operation) || message.id!==intent.id || message.owner!==intent.owner
            || message.startTicks!==live.startTicks || supplied.length!==expected.length
            || !timingSafeEqual(supplied,expected)){socket.destroy();return}
          if(message.operation==='detach') {
            if(config.restartDetachable!==true || !provider || stopping){socket.destroy();return}
            bridge?.detach(message.connectionId)
            recordDetachment()
            detached=true
          }
          if(message.operation==='attach' || message.operation==='environment') {
            if(!bridge || !detached || stopping){socket.destroy();return}
            if(message.operation==='attach') {
              if(typeof message.connectionId!=='string'){socket.destroy();return}
              socket.removeAllListeners('data')
              socket.write(JSON.stringify({id:intent.id,startTicks:live.startTicks,accepted:true,
                threadSettings:bridge.settings()})+'\\n')
              bridge.attach(socket,message.connectionId)
              detached=false
              return
            }
            socket.end(JSON.stringify({id:intent.id,startTicks:live.startTicks,accepted:true,
              variables:bridge.environment()})+'\\n')
            return
          }
          socket.end(JSON.stringify({id:intent.id,startTicks:live.startTicks,accepted:true})+'\\n')
          if(message.operation==='stop')stop()
        }catch{socket.destroy()}
      })
    })
    server.maxConnections=8
    server.on('error',stop)
    server.listen({path:'\\0graphql-native-'+intent.id},()=>{
      try {
        let containment
        try{containment=contain(intent.id,dir,intent.owner,boot)}catch(error){
          process.stderr.write('Native launch refused: delegated cgroup v2 with cgroup.kill is required.\\n')
          throw error
        }
        birth(join(dir,'birth.json'),{...certificate,containment})
        if(stopping || !process.connected){stop();return}
        const detachable=config.restartDetachable===true
        const pipedOutput=!!config.claudeSessionScope||detachable
        const native=spawn(config.binary,config.args,{cwd:config.cwd,env:environment,
          detached:false,stdio:[detachable&&!config.claudeSessionScope&&!config.reconnectableStdio?'ignore':'pipe',
            pipedOutput?'pipe':'inherit',pipedOutput?'pipe':'inherit'],windowsHide:true})
        const outputClosed=pipedOutput?new Promise(resolve=>native.once('close',resolve)):Promise.resolve()
        const finishNativeExit=()=>stopAfterNativeExit(outputClosed.then(()=>
          Promise.all([flushOutput(process.stdout),flushOutput(process.stderr),bridge?.flush()])))
        // Forward request input after the provider record so fast replies cannot race owner capture.
        try{if(native.pid)provider=identity(native.pid)}
        catch(error){warnCleanup('read native process identity',error,{nativePid:native.pid},['ENOENT','ESRCH'])}
        try {
          birth(join(dir,'provider.json'),{format:1,id:intent.id,owner:intent.owner,boot,
            guardian:live,...(provider?{provider}:{}),capture:provider?'captured':'unavailable'})
          if(process.connected)process.send({operation:'observation',id:intent.id},()=>{})
        }catch(error){warnCleanup('record native provider',error,{nativePid:native.pid})}
        if(config.claudeSessionScope) {
          capture=claudeCompactionCapture(config.claudeSessionScope,()=>{if(disconnected)stop()})
          let stdoutClosed=false,stderrClosed=false
          process.stdout.on('error',error=>{if(error.code==='EPIPE'){stdoutClosed=true;native.stdout.resume()}else stop()})
          process.stderr.on('error',error=>{if(error.code==='EPIPE'){stderrClosed=true;native.stderr.resume()}else stop()})
          native.stdin.on('error',stop)
          process.stdin.on('data',chunk=>{
            capture.consume('input',chunk)
            if(!native.stdin.write(chunk))process.stdin.pause()
          })
          native.stdin.on('drain',()=>process.stdin.resume())
          process.stdin.on('end',()=>{if(!capture.pending())native.stdin.end()})
          native.stdout.on('data',chunk=>{
            capture.consume('output',chunk)
            if(!stdoutClosed && !process.stdout.write(chunk))native.stdout.pause()
          })
          process.stdout.on('drain',()=>native.stdout.resume())
          native.stderr.on('data',chunk=>{if(!stderrClosed && !process.stderr.write(chunk))native.stderr.pause()})
          process.stderr.on('drain',()=>native.stderr.resume())
        } else if(config.reconnectableStdio) {
          bridge=codexStdioBridge(native,environment,()=>detached,()=>{detached=true})
          if(config.restartDetachable===true) {
            detachOnDisconnect=()=>{
              if(detachRecorded)return true
              if(!recordDetachment())return false
              bridge.detach()
              detached=true
              return true
            }
          }
        } else if(detachable) {
          native.stdout.on('data',chunk=>{if(!detached&&process.connected)process.stdout.write(chunk)})
          native.stderr.on('data',chunk=>{if(!detached&&process.connected)process.stderr.write(chunk)})
        } else {
          native.stdin.on('error',stop)
          process.stdin.pipe(native.stdin)
        }
        native.once('error',stop)
        native.once('exit',(exitCode,exitSignal)=>{
          try {
            birth(join(dir,'provider-exit.json'),{format:1,id:intent.id,owner:intent.owner,boot,
              ...(provider?{provider}:{}),code:exitCode,signal:exitSignal})
            if(process.connected)process.send({operation:'observation',id:intent.id},()=>{})
          }catch(error){warnCleanup('record native provider exit',error,{nativePid:native.pid})}
          try {
            const outcome={format:1,operation:'native_exit',id:intent.id,owner:intent.owner,boot,
              guardian:{pid:live.pid,startTicks:live.startTicks},nativePid:native.pid,exitCode,exitSignal}
            // Persist/send the outcome immediately, then join the separate output relay.
            if(process.connected)process.send(outcome,finishNativeExit)
            else finishNativeExit()
          }catch{finishNativeExit()}
        })
      }catch{stop()}
    })
  }catch{stop()}
})
if(!process.connected)stop()
`
