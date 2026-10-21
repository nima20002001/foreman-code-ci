import type { QualificationNativeOwner } from './qualificationPorts.js'
import type { JobVerificationQualificationCandidateSchema } from '@foreman-code/contracts/job-verification-runtime'
import type { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'

// The diagnostic owns an ordinary suite and remains active under byte/inode pressure.
export const QUALIFICATION_PRESSURE_DRIVER = `const fs=require('node:fs'),{spawn}=require('node:child_process');
const quotaErrno=-require('node:os').constants.errno.EDQUOT;
const context=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const log=context.identity.suite==='install'?'install':'root';
const child=spawn('node',['/opt/graphql-ci/verification/verify-repository.mjs','--context',process.argv[1]],{stdio:'ignore'});
child.on('error',()=>process.exit(2));
const poll=setInterval(()=>{
if(!fs.existsSync('.logs/verification/parts/'+log+'.log'))return;
clearInterval(poll);let byteError,inodeError;
try{const fd=fs.openSync('/job-scratch/pressure-bytes','wx');const chunk=Buffer.alloc(1048576,1);
try{for(;;){fs.writeSync(fd,chunk);fs.fsyncSync(fd)}}finally{fs.closeSync(fd)}}catch(e){byteError=e.errno}
try{fs.mkdirSync('/job-scratch/pressure-inodes');for(let n=0;;n++)
fs.closeSync(fs.openSync('/job-scratch/pressure-inodes/'+n,'wx'))}catch(e){inodeError=e.errno}
if(byteError!==quotaErrno||inodeError!==quotaErrno)process.exit(3);
setInterval(()=>{},1000);
process.stdout.write('ACTIVE_QUOTA_PRESSURE\\n');
},100);`

export async function interruptActiveQualification(input: {
  owner: QualificationNativeOwner
  candidate: z.infer<typeof JobVerificationQualificationCandidateSchema>
  containerId: string
  contextPath: string
  startedAt: string
  outcome: 'cancelled' | 'timed_out'
  signal: AbortSignal
}) {
  const { owner, candidate } = input
  if (!owner.closeContainer) throw new Error('Original container cancellation authority is unavailable.')
  const argv = ['--remote=false', 'exec', input.containerId, 'node', '-e', QUALIFICATION_PRESSURE_DRIVER, input.contextPath]
  const reservation = await owner.reserveProcess(candidate.fingerprint.runtimeExecutable, argv)
  input.signal.throwIfAborted()
  const child = owner.spawnProcess(reservation, candidate.fingerprint.runtimeExecutable, argv,
    { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: candidate.controllerEnvironment })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve())
    child.once('error', reject)
  })
  // Join the controller after the original container has been stopped.
  void exited.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
  let output = ''
  const active = new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (bytes: Buffer) => {
      output += bytes.toString('utf8')
      if (output.length > 1024) reject(new Error('Cancellation probe output exceeded its bound.'))
      if (output === 'ACTIVE_QUOTA_PRESSURE\n') resolve()
    })
    child.once('close', () => reject(new Error('Ordinary suite ended before active quota pressure was observed.')))
    child.once('error', reject)
  })
  const waiting = new AbortController()
  const executionDeadline = Date.parse(input.startedAt) + candidate.profile.spec.policy.executionTimeoutMs
  const remaining = () => Math.max(1, executionDeadline - Date.now())
  const deadline = AbortSignal.any([waiting.signal, input.signal, AbortSignal.timeout(remaining())])
  let failure: unknown
  try {
    await Promise.race([active, delay(remaining(), undefined,
      { signal: deadline }).then(() => { throw new Error('Active cancellation probe deadline expired.') })])
    if (input.outcome === 'timed_out') await delay(remaining(), undefined, { signal: input.signal })
  } catch (error) {
    failure = error
  } finally { waiting.abort() }
  if (!await owner.closeContainer()) {
    throw new Error('Active verification descendant closure is unconfirmed.', { cause: failure })
  }
  await exited
  if (failure) throw failure
  return { outcome: input.outcome, exitCode: null, signal: null, finishedAt: new Date().toISOString() }
}
