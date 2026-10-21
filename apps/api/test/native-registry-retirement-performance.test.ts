import { tmpdir } from 'node:os'
import { createHash,randomUUID } from 'node:crypto'
import { existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe,expect,it,vi } from 'vitest'
import { NativeProcessRegistry } from '../src/modules/harnesses/recovery/processRegistry.js'
import { runCommand } from '../src/modules/harnesses/process.js'
import { nativeRegistryProjection,type NativeLaunchObservation } from '../src/modules/harnesses/recovery/registryObservation.js'
import { bootIdentity,processIdentity } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { privateDirectory,readRecord,writeRecord } from '../src/modules/harnesses/recovery/storage.js'

function fixture() {
  const root=mkdtempSync(join(tmpdir(), 'native-retirement-')),owner='original-retirement-test-owner'
  const ownerDirectory=privateDirectory(join(root,createHash('sha256').update(owner).digest('hex')))
  const registry=new NativeProcessRegistry(root)
  function seedClosed(id=randomUUID(),oldBoot=false) {
    const path=join(ownerDirectory,id);mkdirSync(path,{mode:0o700})
    const intent={format:1,id,owner,boot:oldBoot?'earlier-boot':bootIdentity(),parent:processIdentity(process.pid)!,controlKey:'a'.repeat(64)}
    // Same prior durable-certificate fixture and 10,005 scale as original F11.
    // No provider, guardian or process is launched by these metadata tests.
    writeFileSync(join(path,'intent.json'),JSON.stringify(intent),{mode:0o600})
    writeFileSync(join(path,'closed.json'),JSON.stringify(oldBoot?{format:1,id,owner,evidence:'linux_boot_or_session_absence'}
      :{format:2,id,owner,boot:intent.boot,evidence:'native_not_started'}),{mode:0o600})
    return {id,path,intent}
  }
  return {root,owner,ownerDirectory,registry,seedClosed}
}
describe.skipIf(process.platform!=='linux')('bounded original native retirement projection',()=>{
  it.each(['cleanup', 'admission'] as const)('keeps timers running while %s makes a large retirement batch durable', async operation => {
    const f = fixture()
    const ids = Array.from({ length: 1_000 }, () => f.seedClosed().id)
    let ticks = 0
    const timer = setInterval(() => { ticks++ }, 1)
    try {
      if (operation === 'cleanup') expect(await f.registry.closeOwner(f.owner)).toBe(true)
      else {
        const scope = await f.registry.reserveLaunch(f.owner)
        expect(scope.launchId).toBeDefined()
        expect(await f.registry.abandonReservedLaunch(scope)).toBe(true)
      }
      expect(ticks).toBeGreaterThan(1)
      for (const id of ids) {
        expect(f.registry.closedRegistration(f.owner, id)).toMatchObject({
          owner: f.owner, launchId: id, lifecycle: 'closed', closureEvidence: 'native_not_started',
        })
        expect(existsSync(join(f.ownerDirectory, id))).toBe(false)
      }
    } finally {
      clearInterval(timer)
      rmSync(f.root, { recursive: true, force: true })
    }
  })
  it('serializes competing admissions through retirement before publishing one launch', async () => {
    const f = fixture()
    const ids = Array.from({ length: 100 }, () => f.seedClosed().id)
    try {
      const other = new NativeProcessRegistry(f.root)
      const results = await Promise.allSettled([
        f.registry.reserveLaunch(f.owner), other.reserveLaunch(f.owner),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.find(result => result.status === 'rejected')
      expect(rejected?.reason).toEqual(expect.objectContaining({
        message: expect.stringContaining('active or unconfirmed'),
      }))
      for (const id of ids) expect(other.closedRegistration(f.owner, id)?.lifecycle).toBe('closed')
      const winner = results.find(result => result.status === 'fulfilled')!
      expect(await other.abandonReservedLaunch(winner.value)).toBe(true)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  })
  it('abandons the new reservation when cancellation arrives during retirement before command dispatch', async () => {
    const f = fixture()
    const ids = Array.from({ length: 100 }, () => f.seedClosed().id)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('command canceled during retirement')), 1)
    try {
      await expect(runCommand(process.execPath,
        ['-e', "require('node:fs').writeFileSync('unexpected-native-start', '')"], f.root,
        controller.signal, undefined, { recovery: f.registry.scope(f.owner) }))
        .rejects.toThrow('command canceled during retirement')
      expect(existsSync(join(f.root, 'unexpected-native-start'))).toBe(false)
      expect(await f.registry.closeOwner(f.owner)).toBe(true)
      const snapshot = f.registry.snapshot()
      expect(snapshot.launches).toHaveLength(ids.length + 1)
      expect(snapshot.launches.every(row => row.lifecycle === 'closed')).toBe(true)
    } finally {
      clearTimeout(timer)
      rmSync(f.root, { recursive: true, force: true })
    }
  })
  it('compacts all 10,005 original F11 registrations with a bounded number of full inventory scans',async()=>{
    const f=fixture(),projection=nativeRegistryProjection(f.root)
    const baseline=f.registry.snapshot(),controller=new AbortController()
    const iterator=f.registry.changes(baseline.revision,controller.signal)[Symbol.asyncIterator](),pending=iterator.next()
    const snapshot=projection.snapshot.bind(projection),captures=vi.spyOn(projection,'observeRetirement')
    let scans=0
    // Bound the BEFORE diagnostic: execute one genuine full scan and count all
    // subsequent calls without repeating quadratic IO. This changes derived
    // telemetry in this probe only; every real retirement/receipt/GC still runs.
    const probe=vi.spyOn(projection,'snapshot').mockImplementation(()=>{
      scans++
      return scans===1?snapshot():{revision:projection.revision(),launches:[]}
    })
    try {
      const ids = Array.from({ length: 10_005 }, (_, index) => f.seedClosed(randomUUID(), index < 3).id)
      const started=performance.now()
      expect(await f.registry.closeOwner(f.owner)).toBe(true)
      const elapsedMs=Math.round(performance.now()-started)
      process.stdout.write(`${JSON.stringify({probe:'F11-retirement',registrations:10_005,fullScans:scans,targetedCaptures:captures.mock.calls.length,elapsedMs})}\n`)
      // Per-record fsyncs took ~4 min here; batched syncs take ~25 s. The bound tolerates loaded CI computers.
      expect(elapsedMs).toBeLessThan(120_000)
      expect(readdirSync(f.ownerDirectory).sort()).toEqual([...ids.map(id => `closed-${id}.json`), 'retired.json'].sort())
      for (const id of ids) {
        expect(readRecord(join(f.ownerDirectory, `closed-${id}.json`))).toMatchObject({
          owner: f.owner, launchId: id, lifecycle: 'closed',
          closureEvidence: expect.stringMatching(/^(native_not_started|linux_boot_changed)$/),
        })
      }
      expect(scans).toBeLessThanOrEqual(1)
      expect(captures).toHaveBeenCalledTimes(10_005)
      const event=await pending
      expect(event.value?.gap).toBe(true)
      expect(event.value?.revision.split(':').at(-1)).toBe('1')
      expect(event.value?.launches).toHaveLength(10_000)
      probe.mockRestore()
      const current=f.registry.snapshot()
      expect(current.launches).toHaveLength(10_000)
      expect(current.launches.every(row=>row.lifecycle==='closed')).toBe(true)
      expect(await f.registry.closeOwner(f.owner)).toBe(true)
      const next=await f.registry.reserveLaunch(f.owner)
      writeRecord(join(f.ownerDirectory,next.launchId!,'not-started.json'),{id:next.launchId,owner:f.owner})
      await f.registry.closeRegistration(next,next.launchId!)
      await f.registry.closeRegistration(next,next.launchId!)
      await expect(f.registry.closeRegistration(next,randomUUID())).rejects.toMatchObject({code:'ENOENT'})
    }finally{probe.mockRestore();captures.mockRestore();controller.abort();await iterator.return?.();rmSync(f.root,{recursive:true,force:true})}
  // Scan counts bound the algorithm; the timeout allows 10,005 durable receipt writes on slower disks.
  },1_200_000)
  it('publishes a positive exact closure to subscribers before an immediate read after retirement',async()=>{
    const f=fixture(),controller=new AbortController()
    try {
      const scope=await f.registry.reserveLaunch(f.owner),before=f.registry.snapshot()
      const iterator=f.registry.changes(before.revision,controller.signal)[Symbol.asyncIterator](),pending=iterator.next()
      writeRecord(join(f.ownerDirectory,scope.launchId!,'not-started.json'),{id:scope.launchId,owner:f.owner})
      await f.registry.closeRegistration(scope,scope.launchId!)
      const event=await pending,current=f.registry.snapshot()
      expect(event.value?.launches.find((row:NativeLaunchObservation)=>row.launchId===scope.launchId)).toMatchObject({owner:f.owner,lifecycle:'closed',closureEvidence:'native_not_started'})
      expect(current.launches).toEqual(event.value?.launches)
      expect(existsSync(join(f.ownerDirectory,scope.launchId!))).toBe(false)
      await f.registry.closeRegistration(scope,scope.launchId!)
      await expect(f.registry.closeRegistration(scope,randomUUID())).rejects.toMatchObject({code:'ENOENT'})
      controller.abort();await iterator.return?.()
    }finally{controller.abort();rmSync(f.root,{recursive:true,force:true})}
  },30_000)
  it('flushes valid prior closures when later inventory validation fails without promoting the corrupt row',async()=>{
    const f=fixture(),controller=new AbortController()
    try {
      const baseline=f.registry.snapshot()
      f.seedClosed();f.seedClosed()
      const [first,second]=readdirSync(f.ownerDirectory)
      const iterator=f.registry.changes(baseline.revision,controller.signal)[Symbol.asyncIterator](),pending=iterator.next()
      writeRecord(join(f.ownerDirectory,second!,'closed.json'),{format:2,id:second,owner:'foreign',boot:bootIdentity(),evidence:'native_not_started'})
      await expect(f.registry.closeOwner(f.owner)).rejects.toThrow('close evidence owner mismatch')
      expect(existsSync(join(f.ownerDirectory,first!))).toBe(false)
      expect(existsSync(join(f.ownerDirectory,second!))).toBe(true)
      const event=await pending
      expect(event.value?.launches.find((row:NativeLaunchObservation)=>row.launchId===first)?.lifecycle).toBe('closed')
      // The prior valid snapshot remains immutable; the corrupted actual row
      // must still reject a fresh authoritative scan rather than hiding it.
      expect(()=>f.registry.snapshot()).toThrow('closure owner mismatch')
      controller.abort();await iterator.return?.()
    }finally{controller.abort();rmSync(f.root,{recursive:true,force:true})}
  })
  it('retains unresolved original registrations while flushing successful closures and blocks reuse',async()=>{
    const f=fixture()
    try {
      const closed=f.seedClosed(),active=await f.registry.reserveLaunch('other-owner')
      // Add a genuine write-ahead reservation for this same owner as well.
      const original=await f.registry.reserveLaunch(f.owner)
      await expect(f.registry.closeOwner(f.owner,AbortSignal.timeout(25))).rejects.toThrow('closure remains unconfirmed')
      const snapshot=f.registry.snapshot()
      expect(snapshot.launches.find(row=>row.launchId===closed.id)?.lifecycle).toBe('closed')
      expect(snapshot.launches.find(row=>row.launchId===original.launchId)?.lifecycle).toBe('closure-unconfirmed')
      expect(snapshot.launches.find(row=>row.launchId===active.launchId)?.owner).toBe('other-owner')
      expect(existsSync(join(f.ownerDirectory,original.launchId!,'intent.json'))).toBe(true)
      await expect(f.registry.reserveLaunch(f.owner)).rejects.toThrow('active or unconfirmed')
    }finally{rmSync(f.root,{recursive:true,force:true})}
  })
  it('merges immediate reads and interleaved real reservations into the final asynchronous batch',async()=>{
    const f=fixture(),projection=nativeRegistryProjection(f.root),controller=new AbortController()
    try {
      const closed=f.seedClosed(),baseline=f.registry.snapshot()
      const iterator=f.registry.changes(baseline.revision,controller.signal)[Symbol.asyncIterator](),pending=iterator.next()
      let retirement:Promise<void>|undefined,scope:Awaited<ReturnType<NativeProcessRegistry['reserveLaunch']>>|undefined
      await projection.retirementBatch(async ()=>{
        retirement=f.registry.closeRegistration(f.registry.scope(f.owner),closed.id)
        scope=await f.registry.reserveLaunch('interleaved-owner')
        await retirement
        expect(existsSync(closed.path)).toBe(false)
        const immediate=f.registry.snapshot()
        expect(immediate.launches.find(row=>row.launchId===closed.id)?.lifecycle).toBe('closed')
        expect(immediate.launches.find(row=>row.launchId===scope!.launchId)?.owner).toBe('interleaved-owner')
      })
      await retirement
      const event=await pending,current=f.registry.snapshot()
      expect(current.launches.find(row=>row.launchId===closed.id)?.lifecycle).toBe('closed')
      expect(current.launches.find(row=>row.launchId===scope!.launchId)).toMatchObject({owner:'interleaved-owner',lifecycle:'closure-unconfirmed'})
      expect(event.value?.launches).toEqual(current.launches)
      await expect(f.registry.reserveLaunch('interleaved-owner')).rejects.toThrow('active or unconfirmed')
      controller.abort();await iterator.return?.()
    }finally{controller.abort();rmSync(f.root,{recursive:true,force:true})}
  })
  it.each(['closure-owner','closure-boot','birth-owner','provider-generation','missing','foreign-root'] as const)(
    'does not publish a targeted %s observation as retirement authority',async defect=>{
      const f=fixture(),projection=nativeRegistryProjection(f.root)
      try {
        const row=f.seedClosed(),before=f.registry.snapshot()
        let path=row.path
        if(defect==='closure-owner')writeRecord(join(path,'closed.json'),{format:2,id:row.id,owner:'foreign',boot:row.intent.boot,evidence:'native_not_started'})
        if(defect==='closure-boot')writeRecord(join(path,'closed.json'),{format:2,id:row.id,owner:f.owner,boot:'foreign',evidence:'native_not_started'})
        if(defect==='birth-owner')writeRecord(join(path,'birth.json'),{format:1,id:row.id,owner:'foreign',boot:row.intent.boot,guardian:processIdentity(process.pid)!})
        if(defect==='provider-generation'){
          const guardian=processIdentity(process.pid)!
          writeRecord(join(path,'birth.json'),{format:1,id:row.id,owner:f.owner,boot:row.intent.boot,guardian})
          writeRecord(join(path,'provider.json'),{format:1,id:row.id,owner:f.owner,boot:row.intent.boot,guardian:{...guardian,startTicks:'0'},provider:guardian,capture:'captured'})
        }
        if(defect==='missing')path=join(f.ownerDirectory,randomUUID())
        if(defect==='foreign-root')path=join(tmpdir(),createHash('sha256').update(f.owner).digest('hex'),row.id)
        expect(()=>projection.observeRetirement(path)).toThrow()
        expect(projection.revision()).toBe(before.revision)
        expect(existsSync(row.path)).toBe(true)
      }finally{rmSync(f.root,{recursive:true,force:true})}
    })
})
