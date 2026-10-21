import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DomainError } from '../errors.js'
import { atomicBrowserPrivateJson } from './journal.js'
import { BrowserCdpConnection, type CdpEvent } from './cdp.js'
import { runBrowserUseAction, type BrowserRuntimeInstallation } from './browserUseAdapter.js'
import type { BrowserNativeDriver, BrowserNativeDispatch, BrowserPageInput, BrowserHostFrame,
  BrowserPageObservation, NativeBrowserTab, BrowserNativeFacts, BrowserNativeDownload } from './types.js'
import { browserProcessAlive, browserProcessBirthId, readBrowserProcessIdentity, writeBrowserProcessIdentity, verifyBrowserProcess, type BrowserProcessIdentity } from './processIdentity.js'
import { assertPortableBrowserCookies, type BrowserPortableState } from './snapshotStorage.js'
import { createBrowserRuntimeDirectory, removeBrowserRuntimeDirectory } from '../../../../worker/src/browserRuntimeInstall.mjs'

interface AttachedTab {
  id: string; sessionId: string; title: string; url: string
  keys: Map<string, Record<string, unknown>>; buttons: Set<string>; pointer: { x: number; y: number }
  dialog: { type: string; message: string; defaultPrompt?: string } | null
  frameIds: Set<string>; chooser: { id: string; backendNodeId: number; multiple: boolean } | null
}
interface NativeProfile {
  generation: number; process: ChildProcess | null; identity: BrowserProcessIdentity; connection: BrowserCdpConnection
  tabs: Map<string, AttachedTab>; headless: boolean
  pendingPopups: Set<Promise<void>>
}
interface HeldInputRecord {
  generation: number
  targets: Array<{ id: string; keys: Array<Record<string, unknown>>; buttons: string[]; pointer: { x: number; y: number } }>
}
export interface BrowserNativeDriverOptions {
  runtime: BrowserRuntimeInstallation
  actionDirectory: string
  profileDirectory(profileId: string): Promise<{ directory: string; generation: number }>
  allocateGeneration(profileId: string): Promise<number>
  onOrigin(profileId: string, origin: string): Promise<void>
  onDisconnected(profileId: string, generation: number): void
  graphical?: boolean
  downloadDirectory?(profileId: string): string
  onDownload?(event: BrowserNativeDownload): Promise<void>
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const PAGE_METHODS = new Set(['Page.navigate', 'Page.handleJavaScriptDialog', 'Page.captureScreenshot',
  'Page.getNavigationHistory', 'Page.navigateToHistoryEntry', 'Page.reload',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.imeSetComposition',
  'Input.cancelDragging', 'Runtime.evaluate', 'DOM.getDocument', 'DOM.querySelector', 'DOM.setFileInputFiles'])

export class ManagedBrowserNativeDriver implements BrowserNativeDriver {
  private readonly profiles = new Map<string, NativeProfile>()
  private readonly reconnecting = new Map<string, Promise<{ generation: number } | null>>()
  private readonly inputWrites = new Map<string, Promise<void>>()
  private readonly opening = new Map<string, Promise<{ generation: number }>>()
  private readonly popups = new Set<Parameters<BrowserNativeDriver['onPopup']>[0]>()
  private readonly tabClosed = new Set<Parameters<BrowserNativeDriver['onTabClosed']>[0]>()
  private readonly downloads = new Map<string, BrowserNativeDownload>()
  private readonly captures = new Map<string, Promise<{ connection: BrowserCdpConnection; listeners: Set<(frame: BrowserHostFrame) => void>; stop: () => Promise<void> }>>()
  private readonly retiringCaptures = new Map<string, Promise<void>>()
  constructor(readonly options: BrowserNativeDriverOptions) {}

  ownedProfileIds(): string[] { return [...new Set([...this.profiles.keys(), ...this.opening.keys(), ...this.reconnecting.keys()])] }

  openProfile(profileId: string): Promise<{ generation: number }> {
    const opened = this.profiles.get(profileId)
    if (opened) return Promise.resolve({ generation: opened.generation })
    const reconnecting = this.reconnecting.get(profileId)
    if (reconnecting) return reconnecting.then(value => value ?? this.openProfile(profileId))
    const pending = this.opening.get(profileId)
    if (pending) return pending
    const task = this.launch(profileId).finally(() => this.opening.delete(profileId))
    this.opening.set(profileId, task)
    return task
  }

  reconnectProfile(profileId: string): Promise<{ generation: number } | null> {
    const pending = this.opening.get(profileId) ?? this.reconnecting.get(profileId)
    if (pending) return pending
    const task = this.reconnectNative(profileId).finally(() => this.reconnecting.delete(profileId))
    this.reconnecting.set(profileId, task); return task
  }

  private async reconnectNative(profileId: string): Promise<{ generation: number } | null> {
    const current = this.profiles.get(profileId)
    if (current) return { generation: current.generation }
    const { directory } = await this.options.profileDirectory(profileId)
    const identity = await readBrowserProcessIdentity(directory)
    if (!identity || !browserProcessAlive(identity.pid, identity.birthId)) return null
    if (!identity.endpoint || identity.executable !== this.options.runtime.chromiumExecutable) {
      throw new DomainError('BROWSER_PROCESS_OWNERSHIP', 'The existing managed browser needs recovery.', 503)
    }
    const connection = await BrowserCdpConnection.connect(identity.endpoint)
    try { await verifyBrowserProcess(connection, identity) } catch (error) { connection.close(); throw error }
    this.install(profileId, identity, connection, null)
    await this.configureProfile(profileId, connection)
    return { generation: identity.generation }
  }

  private install(profileId: string, identity: BrowserProcessIdentity, connection: BrowserCdpConnection,
    processHandle: ChildProcess | null): NativeProfile {
    const profile: NativeProfile = { generation: identity.generation, process: processHandle, identity,
      connection, tabs: new Map(), headless: identity.headless, pendingPopups: new Set() }
    this.profiles.set(profileId, profile)
    connection.onEvent(event => this.event(profileId, profile, event))
    connection.onDisconnected(() => {
      if (this.profiles.get(profileId) !== profile) return
      this.profiles.delete(profileId); this.options.onDisconnected(profileId, identity.generation)
    })
    processHandle?.once('exit', () => connection.close())
    return profile
  }

  private async configureProfile(profileId: string, connection: BrowserCdpConnection): Promise<void> {
    const directory = this.options.downloadDirectory?.(profileId)
    if (directory) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await connection.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: directory, eventsEnabled: true })
    } else await connection.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true })
    await connection.send('Target.setDiscoverTargets', { discover: true })
  }

  private async launch(profileId: string): Promise<{ generation: number }> {
    const { directory } = await this.options.profileDirectory(profileId)
    const previous = await readBrowserProcessIdentity(directory)
    if (previous && browserProcessAlive(previous.pid, previous.birthId)) {
      if (!previous.endpoint || previous.executable !== this.options.runtime.chromiumExecutable) {
        throw new DomainError('BROWSER_PROCESS_OWNERSHIP', 'The existing managed browser needs recovery before this runtime can open it.', 503)
      }
      const connection = await BrowserCdpConnection.connect(previous.endpoint)
      try { await verifyBrowserProcess(connection, previous) } catch (error) { connection.close(); throw error }
      this.install(profileId, previous, connection, null)
      await this.configureProfile(profileId, connection)
      return { generation: previous.generation }
    }
    const activePortPath = join(directory, 'DevToolsActivePort')
    if (previous) {
      await removeBrowserRuntimeDirectory(previous.runtimeDirectory)
      await rm(activePortPath, { force: true })
    }
    else {
      try {
        await readFile(activePortPath)
        throw new DomainError('BROWSER_PROCESS_OWNERSHIP', 'An unverified process endpoint exists for this profile.', 503)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const generation = await this.options.allocateGeneration(profileId), token = randomUUID()
    const desktop = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
    const headless = this.options.graphical === false || this.options.graphical !== true && !desktop
    const args = [`--user-data-dir=${directory}`, `--foreman-browser-owner=${token}`, '--enable-automation',
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', ...(headless ? ['--headless=new'] : []), 'about:blank']
    // Chromium's own profile lock remains authoritative; no lock removal or sandbox bypass.
    const runtimeDirectory = await createBrowserRuntimeDirectory(this.options.actionDirectory)
    const processHandle = spawn(this.options.runtime.chromiumExecutable, args, { stdio: 'ignore',
      env: { ...process.env, TMPDIR: runtimeDirectory?.temporaryDirectory ?? process.env.TMPDIR } })
    processHandle.once('exit', () => {
      void removeBrowserRuntimeDirectory(runtimeDirectory).catch(error => console.error('Managed browser runtime directory cleanup failed', error))
    })
    let failed: Error | undefined
    processHandle.once('error', error => { failed = error })
    let connection: BrowserCdpConnection | undefined
    const identity: BrowserProcessIdentity = { pid: processHandle.pid ?? 0, generation, token,
      executable: this.options.runtime.chromiumExecutable, directory, headless, endpoint: null, runtimeDirectory,
      birthId: processHandle.pid ? browserProcessBirthId(processHandle.pid) : null }
    try {
      if (!identity.pid) throw new Error('Browser process did not start')
      await writeBrowserProcessIdentity(identity)
      for (let attempt = 0; attempt < 150; attempt++) {
        if (failed || processHandle.exitCode !== null) throw failed ?? new Error('Browser launch exited')
        try {
          const [port, path] = (await readFile(activePortPath, 'utf8')).trim().split('\n')
          if (port && /^\d+$/.test(port) && path?.startsWith('/devtools/browser/')) {
            identity.endpoint = `ws://127.0.0.1:${port}${path}`
            connection = await BrowserCdpConnection.connect(identity.endpoint)
            await verifyBrowserProcess(connection, identity); break
          }
        } catch (error) {
          connection?.close(); connection = undefined
          if (attempt === 149) throw error
        }
        await delay(100)
      }
      if (!connection) throw new Error('Browser endpoint unavailable')
      await writeBrowserProcessIdentity(identity)
      this.install(profileId, identity, connection, processHandle)
      await this.configureProfile(profileId, connection)
      return { generation }
    } catch (error) {
      connection?.close(); processHandle.kill('SIGTERM')
      if (!processHandle.pid || !browserProcessAlive(identity.pid, identity.birthId)) await removeBrowserRuntimeDirectory(runtimeDirectory)
      throw new DomainError('BROWSER_RUNTIME_MISSING', 'The managed browser could not start. Check runtime setup and the profile lock.', 503, undefined, { cause: error })
    }
  }

  private profile(profileId: string, generation: number): NativeProfile {
    const value = this.profiles.get(profileId)
    if (!value || value.generation !== generation) throw new DomainError('BROWSER_STALE_GENERATION', 'The browser process generation changed.', 409)
    return value
  }

  private async attach(profile: NativeProfile, targetId: string, title = '', url = 'about:blank'): Promise<AttachedTab> {
    const previous = profile.tabs.get(targetId)
    if (previous) return previous
    const result = object(await profile.connection.send('Target.attachToTarget', { targetId, flatten: true }))
    const sessionId = text(result.sessionId)
    if (!sessionId) throw new DomainError('BROWSER_ATTACH_FAILED', 'The browser tab could not be attached.', 503)
    const tab: AttachedTab = { id: targetId, sessionId, title, url, keys: new Map(), buttons: new Set(), pointer: { x: 0, y: 0 }, dialog: null, frameIds: new Set(), chooser: null }
    try {
      await this.inputWrites.get(profile.identity.directory)
      const receipt = JSON.parse(await readFile(join(profile.identity.directory, 'foreman-input-state.json'), 'utf8')) as HeldInputRecord
      const saved = receipt.generation === profile.generation ? receipt.targets.find(value => value.id === targetId) : undefined
      if (saved) { tab.keys = new Map(saved.keys.map(value => [text(value.code) || text(value.key), value])); tab.buttons = new Set(saved.buttons); tab.pointer = saved.pointer }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    profile.tabs.set(targetId, tab)
    await profile.connection.send('Page.enable', {}, sessionId)
    await profile.connection.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId)
    // Tabs open in the background; without focus emulation Chromium drops keyboard and IME input to them.
    await profile.connection.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
    const tree = object(object(await profile.connection.send('Page.getFrameTree', {}, sessionId)).frameTree)
    const collect = (value: Record<string, unknown>) => {
      const id = text(object(value.frame).id); if (id) tab.frameIds.add(id)
      for (const child of Array.isArray(value.childFrames) ? value.childFrames : []) collect(object(child))
    }
    collect(tree)
    return tab
  }

  private event(profileId: string, profile: NativeProfile, event: CdpEvent): void {
    if (event.method === 'Target.targetDestroyed') {
      const targetId = text(event.params.targetId)
      if (profile.tabs.delete(targetId)) for (const listener of this.tabClosed) listener(profileId, profile.generation, targetId)
      void this.savePressed(profile, targetId).catch(() => this.options.onDisconnected(profileId, profile.generation))
      return
    }
    if (event.method.startsWith('Browser.download')) { this.downloadEvent(profileId, profile, event); return }
    if (event.method === 'Target.targetCreated') {
      const info = object(event.params.targetInfo), openerId = text(info.openerId), targetId = text(info.targetId)
      if (info.type !== 'page' || !openerId || !profile.tabs.has(openerId) || !targetId) return
      const pending = this.attach(profile, targetId, text(info.title), text(info.url)).then(async tab => {
        for (const listener of this.popups) await listener(profileId, profile.generation, openerId,
          { targetId: tab.id, title: tab.title, url: tab.url })
      })
      profile.pendingPopups.add(pending)
      void pending.finally(() => profile.pendingPopups.delete(pending))
        .catch(() => this.options.onDisconnected(profileId, profile.generation))
      return
    }
    const tab = [...profile.tabs.values()].find(value => value.sessionId === event.sessionId)
    if (!tab) return
    if (event.method === 'Page.javascriptDialogOpening') tab.dialog = { type: text(event.params.type),
      message: text(event.params.message).slice(0, 8192), defaultPrompt: text(event.params.defaultPrompt).slice(0, 8192) }
    if (event.method === 'Page.javascriptDialogClosed') tab.dialog = null
    if (event.method === 'Page.fileChooserOpened' && Number.isSafeInteger(event.params.backendNodeId)) {
      tab.chooser = { id: randomUUID(), backendNodeId: Number(event.params.backendNodeId), multiple: event.params.mode === 'selectMultiple' }
    }
    if (event.method === 'Page.frameNavigated') {
      const frame = object(event.params.frame)
      if (typeof frame.id === 'string') tab.frameIds.add(frame.id)
      if (frame.parentId) return
      tab.url = text(frame.url)
      try {
        const url = new URL(tab.url)
        if (['http:', 'https:'].includes(url.protocol)) void this.options.onOrigin(profileId, url.origin)
          .catch(() => this.options.onDisconnected(profileId, profile.generation))
      } catch { /* ignore: about:blank and browser-internal targets are not portable snapshot origins. */ }
    }
  }

  private downloadEvent(profileId: string, profile: NativeProfile, event: CdpEvent): void {
    const nativeId = text(event.params.guid), directory = this.options.downloadDirectory?.(profileId)
    if (!nativeId || !/^[a-zA-Z0-9-]+$/.test(nativeId) || !directory) return
    if (event.method === 'Browser.downloadWillBegin') {
      const target = [...profile.tabs.values()].find(tab => tab.frameIds.has(text(event.params.frameId)))
      if (!target) {
        void profile.connection.send('Browser.cancelDownload', { guid: nativeId })
          .catch(() => this.options.onDisconnected(profileId, profile.generation))
        return
      }
      this.downloads.set(nativeId, { profileId, generation: profile.generation, targetId: target.id,
        nativeId, name: text(event.params.suggestedFilename), byteLength: 0, receivedBytes: 0, state: 'inProgress', privatePath: join(directory, nativeId) })
    }
    const download = this.downloads.get(nativeId)
    if (!download) return
    if (event.method === 'Browser.downloadProgress') {
      download.byteLength = Number(event.params.totalBytes) || 0; download.receivedBytes = Number(event.params.receivedBytes) || 0
      download.state = event.params.state === 'completed' ? 'completed' : event.params.state === 'canceled' ? 'canceled' : 'inProgress'
    }
    if (this.options.onDownload) void this.options.onDownload({ ...download })
      .catch(() => this.options.onDisconnected(profileId, profile.generation))
    if (download.state !== 'inProgress') this.downloads.delete(nativeId)
  }

  async createTab(profileId: string, generation: number, allocationToken?: string): Promise<NativeBrowserTab> {
    const profile = this.profile(profileId, generation)
    const initialUrl = allocationToken ? `about:blank#foreman-allocation-${allocationToken}` : 'about:blank'
    if (allocationToken) {
      const targets = object(await profile.connection.send('Target.getTargets'))
      const existing = (Array.isArray(targets.targetInfos) ? targets.targetInfos : []).map(object)
        .find(value => value.type === 'page' && value.url === initialUrl)
      if (existing) {
        const restored = await this.attach(profile, text(existing.targetId), text(existing.title), initialUrl)
        return { targetId: restored.id, title: restored.title, url: restored.url }
      }
    }
    const result = object(await profile.connection.send('Target.createTarget', { url: initialUrl, background: true }))
    const targetId = text(result.targetId)
    if (!targetId) throw new DomainError('BROWSER_TAB_FAILED', 'The browser did not create a tab.', 503)
    const tab = await this.attach(profile, targetId)
    return { targetId: tab.id, title: tab.title, url: tab.url }
  }

  async restoreTab(profileId: string, generation: number, targetId: string): Promise<NativeBrowserTab | null> {
    const profile = this.profile(profileId, generation)
    const result = object(await profile.connection.send('Target.getTargets'))
    const info = (Array.isArray(result.targetInfos) ? result.targetInfos : []).map(object)
      .find(value => value.targetId === targetId && value.type === 'page')
    if (!info) return null
    const tab = await this.attach(profile, targetId, text(info.title), text(info.url))
    return { targetId: tab.id, title: tab.title, url: tab.url }
  }

  async closeTab(profileId: string, generation: number, targetId: string): Promise<void> {
    const profile = this.profile(profileId, generation)
    if (!profile.tabs.has(targetId)) return
    for (const download of this.downloads.values()) {
      if (download.profileId === profileId && download.generation === generation && download.targetId === targetId) {
        await profile.connection.send('Browser.cancelDownload', { guid: download.nativeId })
      }
    }
    const result = object(await profile.connection.send('Target.closeTarget', { targetId }))
    if (result.success !== true) throw new DomainError('BROWSER_CLOSE_UNCONFIRMED', 'Browser tab closure is not confirmed.', 503)
    profile.tabs.delete(targetId)
    await this.savePressed(profile, targetId)
  }

  private savePressed(profile: NativeProfile, closedTargetId?: string): Promise<void> {
    // Only currently held physical keys/buttons are retained, without text, composition, or input history.
    const snapshot = { generation: profile.generation, targets: [...profile.tabs.values()].map(tab => ({ id: tab.id,
      keys: [...tab.keys.values()].map(value => ({ type: 'keyDown', code: value.code,
        key: text(value.key).length > 1 ? value.key : 'Unidentified', modifiers: value.modifiers,
        windowsVirtualKeyCode: value.windowsVirtualKeyCode, nativeVirtualKeyCode: value.nativeVirtualKeyCode })),
      buttons: [...tab.buttons], pointer: tab.pointer })) }
    const key = profile.identity.directory, prior = this.inputWrites.get(key) ?? Promise.resolve()
    const save = async () => {
      let previous: HeldInputRecord | undefined
      try { previous = JSON.parse(await readFile(join(key, 'foreman-input-state.json'), 'utf8')) as HeldInputRecord } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      // A sibling session may not have reattached yet. Keep its exact generation/target state until
      // it is explicitly reconciled or the native target is proven closed.
      const targets = new Map((previous?.generation === profile.generation ? previous.targets : []).map(value => [value.id, value]))
      for (const target of snapshot.targets) targets.set(target.id, target)
      if (closedTargetId) targets.delete(closedTargetId)
      await atomicBrowserPrivateJson(key, 'foreman-input-state.json', { generation: profile.generation, targets: [...targets.values()] })
    }
    const task = prior.then(save, save)
    this.inputWrites.set(key, task); return task
  }

  async dispatch(profileId: string, generation: number, targetId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const profile = this.profile(profileId, generation), tab = profile.tabs.get(targetId)
    if (!tab) throw new DomainError('BROWSER_TAB_SCOPE', 'The browser target is not owned.', 403)
    if (method === 'Foreman.pressedState') return { keys: [...tab.keys.values()], buttons: [...tab.buttons], pointer: tab.pointer }
    if (method === 'Foreman.dialog') return tab.dialog
    if (method === 'Foreman.stopCapture') return profile.connection.send('Page.stopScreencast', {}, tab.sessionId)
    if (method === 'Foreman.resumeManagedDialogs') {
      await profile.connection.send('Page.setInterceptFileChooserDialog', { enabled: true }, tab.sessionId)
      tab.chooser = null; return {}
    }
    if (method === 'Foreman.chooserNode') {
      if (!tab.chooser || params.selector !== `foreman-chooser:${tab.chooser.id}`) throw new DomainError('BROWSER_FILE_CHOOSER_STALE', 'The file chooser changed. Read the page again.', 409)
      return { backendNodeId: tab.chooser.backendNodeId }
    }
    if (!PAGE_METHODS.has(method) || 'sessionId' in params || 'targetId' in params || 'browserContextId' in params) {
      throw new DomainError('BROWSER_DISPATCH_DENIED', 'This browser method is unavailable to structured page actions.', 403)
    }
    if (method === 'Input.dispatchKeyEvent') {
      if (params.type === 'keyDown' || params.type === 'rawKeyDown') tab.keys.set(text(params.code) || text(params.key), params)
      if (params.type === 'keyDown' || params.type === 'rawKeyDown') await this.savePressed(profile)
    }
    if (method === 'Input.dispatchMouseEvent') {
      tab.pointer = { x: Number(params.x) || 0, y: Number(params.y) || 0 }
      if (params.type === 'mousePressed') tab.buttons.add(text(params.button))
      if (params.type === 'mousePressed' || tab.buttons.size) await this.savePressed(profile)
    }
    const result = await profile.connection.send(method, params, tab.sessionId)
    if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') { tab.keys.delete(text(params.code) || text(params.key)); await this.savePressed(profile) }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') { tab.buttons.delete(text(params.button)); await this.savePressed(profile) }
    if (method === 'DOM.setFileInputFiles') tab.chooser = null
    return result
  }

  action: BrowserNativeDriver['action'] = (action, dispatch) =>
    runBrowserUseAction(this.options.runtime, action, dispatch, this.options.actionDirectory)

  async observe(dispatch: BrowserNativeDispatch): Promise<BrowserPageObservation> {
    const dialog = await dispatch('Foreman.dialog') as BrowserPageObservation['dialog']
    if (dialog) return { title: '', url: '', text: '', dialog }
    const response = object(await dispatch('Runtime.evaluate', { returnByValue: true,
      expression: '({title:document.title,url:location.href,text:(document.body?.innerText??"").slice(0,32768)})' }))
    if (response.exceptionDetails) throw new DomainError('BROWSER_STATE_UNAVAILABLE', 'The current page state is unavailable.', 503)
    const value = object(object(response.result).value)
    return { title: text(value.title), url: text(value.url), text: text(value.text), dialog: null }
  }

  async input(input: BrowserPageInput, dispatch: BrowserNativeDispatch): Promise<void> {
    if (input.kind === 'pointer') {
      await dispatch('Input.dispatchMouseEvent', { type: input.phase === 'down' ? 'mousePressed' : input.phase === 'up' ? 'mouseReleased' : 'mouseMoved',
        x: input.x, y: input.y, button: ['left', 'middle', 'right'][input.button] ?? 'none', buttons: input.buttons, clickCount: 1 })
    } else if (input.kind === 'wheel') {
      await dispatch('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY })
    } else if (input.kind === 'key') {
      const modifiers = Number(input.alt) + Number(input.control) * 2 + Number(input.meta) * 4 + Number(input.shift) * 8
      await dispatch('Input.dispatchKeyEvent', { type: input.phase === 'down' ? 'keyDown' : 'keyUp', key: input.key, code: input.code,
        modifiers, autoRepeat: input.repeat, ...(input.phase === 'down' && input.key.length === 1 && !input.alt && !input.control && !input.meta ? { text: input.key } : {}) })
    } else if (input.phase === 'end') {
      await dispatch('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
      if (input.text) await dispatch('Input.insertText', { text: input.text })
    } else await dispatch('Input.imeSetComposition', { text: input.text, selectionStart: input.text.length, selectionEnd: input.text.length })
  }

  async releasePressed(dispatch: BrowserNativeDispatch): Promise<void> {
    const state = object(await dispatch('Foreman.pressedState'))
    for (const key of Array.isArray(state.keys) ? state.keys : []) await dispatch('Input.dispatchKeyEvent', { ...object(key), type: 'keyUp', text: '' })
    for (const button of Array.isArray(state.buttons) ? state.buttons : []) {
      await dispatch('Input.dispatchMouseEvent', { ...object(state.pointer), type: 'mouseReleased', button, clickCount: 1 })
    }
    await dispatch('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await dispatch('Input.cancelDragging')
  }

  async capture(profileId: string, generation: number, targetId: string, receive: (frame: BrowserHostFrame) => void): Promise<() => Promise<void>> {
    const profile = this.profile(profileId, generation), tab = profile.tabs.get(targetId)
    if (!tab) throw new DomainError('BROWSER_TAB_SCOPE', 'This target is unavailable.', 403)
    const key = `${profileId}:${generation}:${targetId}`
    await this.retiringCaptures.get(key)
    let pending = this.captures.get(key)
    if (pending && (await pending).connection !== profile.connection) {
      await (await pending).stop()
      if (this.captures.get(key) === pending) this.captures.delete(key)
      pending = undefined
    }
    if (!pending) {
      pending = this.startCapture(profileId, profile, tab)
      this.captures.set(key, pending)
      void pending.catch(() => { if (this.captures.get(key) === pending) this.captures.delete(key) })
    }
    const capture = await pending
    capture.listeners.add(receive)
    let closed = false, stopping: Promise<void> | undefined
    return async () => {
      if (closed) return
      if (stopping) return stopping
      capture.listeners.delete(receive)
      if (capture.listeners.size || this.captures.get(key) !== pending) { closed = true; return }
      const retiring = capture.stop().then(() => {
        closed = true
        if (this.captures.get(key) === pending) this.captures.delete(key)
      }).finally(() => {
        if (this.retiringCaptures.get(key) === retiring) this.retiringCaptures.delete(key)
        if (stopping === retiring) stopping = undefined
      })
      stopping = retiring; this.retiringCaptures.set(key, retiring)
      return retiring
    }
  }

  private async startCapture(profileId: string, profile: NativeProfile, tab: AttachedTab) {
    const listeners = new Set<(frame: BrowserHostFrame) => void>()
    const unsubscribe = profile.connection.onEvent(event => {
      if (event.method !== 'Page.screencastFrame' || event.sessionId !== tab.sessionId) return
      const metadata = object(event.params.metadata), encoded = text(event.params.data)
      if (encoded.length <= 4 * 1024 * 1024) {
        const frame: BrowserHostFrame = { data: Buffer.from(encoded, 'base64'), mimeType: 'image/jpeg',
          width: Number(metadata.deviceWidth) || 1280, height: Number(metadata.deviceHeight) || 800,
          viewportOffsetTop: Number(metadata.offsetTop) || 0, capturedAt: new Date().toISOString() }
        for (const listener of listeners) listener(frame)
      }
      void profile.connection.send('Page.screencastFrameAck', { sessionId: event.params.sessionId }, tab.sessionId)
        .catch(() => this.options.onDisconnected(profileId, profile.generation))
    })
    try {
      await profile.connection.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 }, tab.sessionId)
    } catch (error) { unsubscribe(); throw error }
    return { connection: profile.connection, listeners, stop: async () => {
      if (!browserProcessAlive(profile.identity.pid, profile.identity.birthId)) { unsubscribe(); return }
      if (this.profiles.get(profileId) !== profile) await this.reconnectProfile(profileId)
      const current = this.profiles.get(profileId)
      if (!current || current.generation !== profile.generation) { unsubscribe(); return }
      const target = current.tabs.get(tab.id) ?? (await this.restoreTab(profileId, profile.generation, tab.id) ? current.tabs.get(tab.id) : undefined)
      if (target) await current.connection.send('Page.stopScreencast', {}, target.sessionId)
      unsubscribe()
    } }
  }

  async openLocal(profileId: string, generation: number, targetId: string): Promise<void> {
    const profile = this.profile(profileId, generation)
    if (profile.headless) throw new DomainError('BROWSER_NATIVE_INTERACTION_UNAVAILABLE', 'Continue on this computer requires its graphical desktop session.', 409)
    if (!profile.tabs.has(targetId)) throw new DomainError('BROWSER_TAB_SCOPE', 'This tab is unavailable.', 403)
    await profile.connection.send('Page.setInterceptFileChooserDialog', { enabled: false }, profile.tabs.get(targetId)!.sessionId)
    await profile.connection.send('Target.activateTarget', { targetId })
  }

  onPopup(listener: Parameters<BrowserNativeDriver['onPopup']>[0]): () => void { this.popups.add(listener); return () => this.popups.delete(listener) }
  onTabClosed(listener: Parameters<BrowserNativeDriver['onTabClosed']>[0]): () => void { this.tabClosed.add(listener); return () => this.tabClosed.delete(listener) }
  facts(profileId: string, generation: number, targetId: string): BrowserNativeFacts {
    const tab = this.profile(profileId, generation).tabs.get(targetId)
    if (!tab) throw new DomainError('BROWSER_TAB_SCOPE', 'This tab is no longer owned.', 403)
    return { dialog: tab.dialog, uploadChooser: tab.chooser ? { selector: `foreman-chooser:${tab.chooser.id}`, multiple: tab.chooser.multiple } : null }
  }

  private async enterInertOrigin(profile: NativeProfile, tab: AttachedTab, origin: string): Promise<void> {
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new DomainError('SNAPSHOT_ORIGIN_INVALID', 'A snapshot origin is not a normalized HTTP(S) origin.', 409)
    }
    await profile.connection.send('Network.enable', {}, tab.sessionId)
    await profile.connection.send('Network.setBypassServiceWorker', { bypass: true }, tab.sessionId)
    await profile.connection.send('Network.setCacheDisabled', { cacheDisabled: true }, tab.sessionId)
    await profile.connection.send('Emulation.setScriptExecutionDisabled', { value: true }, tab.sessionId)
    await profile.connection.send('DOMStorage.enable', {}, tab.sessionId)
    let failure: unknown
    const unsubscribe = profile.connection.onEvent(event => {
      if (event.method !== 'Fetch.requestPaused' || event.sessionId !== tab.sessionId) return
      const requestId = text(event.params.requestId)
      const command = event.params.resourceType === 'Document'
        ? profile.connection.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' },
            { name: 'Content-Security-Policy', value: "default-src 'none'; script-src 'none'; connect-src 'none'" }],
          body: Buffer.from('<!doctype html><html><head></head><body></body></html>').toString('base64') }, tab.sessionId)
        : profile.connection.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, tab.sessionId)
      void command.catch(error => { failure = error })
    })
    try {
      await profile.connection.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, tab.sessionId)
      const result = object(await profile.connection.send('Page.navigate', { url: `${origin}/` }, tab.sessionId))
      if (result.errorText) throw new Error('Inert origin navigation failed')
      for (let attempt = 0; attempt < 50; attempt++) {
        if (failure) throw failure
        const tree = object(object(await profile.connection.send('Page.getFrameTree', {}, tab.sessionId)).frameTree)
        const frame = object(tree.frame)
        if (text(frame.securityOrigin) === origin && new URL(text(frame.url)).origin === origin) return
        await delay(100)
      }
      throw new DomainError('SNAPSHOT_ORIGIN_UNAVAILABLE', 'The isolated origin did not commit.', 503)
    } finally { unsubscribe() }
  }

  async exportState(profileId: string, origins: readonly string[]): Promise<BrowserPortableState> {
    const { generation } = await this.openProfile(profileId), profile = this.profile(profileId, generation)
    const result = object(await profile.connection.send('Storage.getCookies'))
    const cookies: Record<string, unknown>[] = [], unsupportedState: BrowserPortableState['unsupportedState'] = []
    for (const raw of Array.isArray(result.cookies) ? result.cookies : []) {
      const cookie = object(raw)
      assertPortableBrowserCookies([cookie])
      const { name, value, domain, path, secure, httpOnly, sameSite, expires, priority, sourceScheme, sourcePort } = cookie
      cookies.push({ name, value, domain, path, secure, httpOnly, ...(sameSite ? { sameSite } : {}),
        ...(typeof expires === 'number' && expires > 0 ? { expires } : {}),
        ...(['Low', 'Medium', 'High'].includes(String(priority)) ? { priority } : {}),
        ...(['Unset', 'NonSecure', 'Secure'].includes(String(sourceScheme)) ? { sourceScheme } : {}),
        ...(Number.isInteger(sourcePort) && (sourcePort === -1 || Number(sourcePort) >= 1 && Number(sourcePort) <= 65535) ? { sourcePort } : {}) })
    }
    const captured: BrowserPortableState['origins'] = []
    const tab = await this.createTab(profileId, generation), attached = profile.tabs.get(tab.targetId)!
    try {
      await profile.connection.send('DOMStorage.enable', {}, attached.sessionId)
      for (const origin of origins) {
        const normalized = new URL(origin)
        if (!['http:', 'https:'].includes(normalized.protocol) || normalized.origin !== origin) {
          throw new DomainError('SNAPSHOT_ORIGIN_INVALID', 'A snapshot origin is not a normalized HTTP(S) origin.', 409)
        }
        try {
          await this.enterInertOrigin(profile, attached, origin)
          const entries = object(await profile.connection.send('DOMStorage.getDOMStorageItems', {
            storageId: { securityOrigin: origin, isLocalStorage: true },
          }, attached.sessionId)).entries
          captured.push({ origin, localStorage: (Array.isArray(entries) ? entries : []).map(value => {
            if (!Array.isArray(value) || value.length !== 2 || !value.every(item => typeof item === 'string')) throw new Error('Invalid local storage entry')
            return { name: value[0] as string, value: value[1] as string }
          }) })
          unsupportedState.push({ origin, reason: 'IndexedDB, service workers and nonportable origin storage are not included.' })
        } catch {
          unsupportedState.push({ origin, reason: 'This origin’s localStorage could not be read. Sign in locally on the destination.' })
        }
      }
    } finally { await this.closeTab(profileId, generation, tab.targetId) }
    return { cookies, origins: captured, unsupportedState }
  }

  async importState(profileId: string, directory: string, generation: number, state: BrowserPortableState): Promise<void> {
    // A temporary host uses the exact fresh directory; it is never published to any agent or viewer.
    const staging = new ManagedBrowserNativeDriver({ ...this.options, graphical: false,
      profileDirectory: async () => ({ directory, generation }), allocateGeneration: async () => generation,
      onOrigin: async () => { /* Staging origins are committed with the verified snapshot. */ },
      onDisconnected: () => { /* The staging importer awaits shutdown before activation. */ } })
    await staging.openProfile(profileId)
    const profile = staging.profile(profileId, generation)
    try {
      if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw new DomainError('SNAPSHOT_STATE_INVALID', 'The browser snapshot format is invalid.', 409)
      await profile.connection.send('Storage.setCookies', { cookies: state.cookies })
      const tab = await staging.createTab(profileId, generation), attached = profile.tabs.get(tab.targetId)!
      await profile.connection.send('DOMStorage.enable', {}, attached.sessionId)
      for (const origin of state.origins) {
        const url = new URL(origin.origin)
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.origin || !Array.isArray(origin.localStorage)) {
          throw new DomainError('SNAPSHOT_STATE_INVALID', 'The browser snapshot contains an invalid origin.', 409)
        }
        await staging.enterInertOrigin(profile, attached, url.origin)
        const storageId = { securityOrigin: url.origin, isLocalStorage: true }
        await profile.connection.send('DOMStorage.clear', { storageId }, attached.sessionId)
        for (const entry of origin.localStorage) {
          if (typeof entry.name !== 'string' || typeof entry.value !== 'string') throw new DomainError('SNAPSHOT_STATE_INVALID', 'The browser snapshot contains invalid origin storage.', 409)
          await profile.connection.send('DOMStorage.setDOMStorageItem', { storageId, key: entry.name, value: entry.value }, attached.sessionId)
        }
      }
      // Restore the exact supported cookie set after inert origin hydration.
      await profile.connection.send('Storage.clearCookies')
      await profile.connection.send('Storage.setCookies', { cookies: state.cookies })
    } finally { await staging.closeProfile(profileId) }
  }

  async settlePopups(profileId: string, generation: number): Promise<void> {
    const profile = this.profile(profileId, generation)
    while (profile.pendingPopups.size) await Promise.all([...profile.pendingPopups])
  }

  async closeProfile(profileId: string): Promise<void> {
    if (!this.profiles.has(profileId)) await this.reconnectProfile(profileId)
    const profile = this.profiles.get(profileId)
    if (!profile) {
      const { directory } = await this.options.profileDirectory(profileId)
      const identity = await readBrowserProcessIdentity(directory)
      if (identity && !browserProcessAlive(identity.pid, identity.birthId)) await removeBrowserRuntimeDirectory(identity.runtimeDirectory)
      return
    }
    try { await profile.connection.send('Browser.close') } catch { /* ignore: Browser.close may close CDP before responding; process exit below is authoritative. */ }
    for (let attempt = 0; attempt < 100 && browserProcessAlive(profile.identity.pid, profile.identity.birthId); attempt++) await delay(100)
    if (browserProcessAlive(profile.identity.pid, profile.identity.birthId)) throw new DomainError('PROFILE_BUSY', 'The browser has not exited; profile storage cannot be replaced.', 409)
    await removeBrowserRuntimeDirectory(profile.identity.runtimeDirectory)
    this.profiles.delete(profileId)
    const { directory } = await this.options.profileDirectory(profileId)
    await rm(join(directory, 'DevToolsActivePort'), { force: true })
  }
}
