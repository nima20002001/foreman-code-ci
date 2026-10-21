#!/usr/bin/env node
/** Native-only FIL-15 smoke for a real, locally authenticated codex-cli 0.157 or later.
 * Uses disposable file fixtures and fixture callbacks, NOT FIL-05
 * HTTP/PostgreSQL or the production adapter. Does not change native configuration.
 * Run: node scripts/smoke-codex-files.mjs [--codex /absolute/codex] [--model model-id]
 *       [--type png|pdf|docx|md|zip|all] [--output /new/result] [--timeout-ms 180000]
 * Build @foreman-code/contracts first so the API format/ZIP helpers can load. The
 * output path must not exist. No npm install or credential issuance occurs.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, open, lstat, realpath, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const exec = promisify(execFile)
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
const types = ['png', 'pdf', 'docx', 'md', 'zip']
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
let helpers

async function fileHelpers() {
  if (helpers) return helpers
  const { tsImport } = await import(requireApi.resolve('tsx/esm/api'))
  const source = (path) => new URL(`../apps/api/src/modules/files/${path}`, import.meta.url).href
  const [fixtures, archives, zip, policy, pdf, docx] = await Promise.all([
    tsImport(source('formats/__tests__/fixtures.ts'), import.meta.url),
    tsImport(source('archives/index.ts'), import.meta.url),
    tsImport(source('archives/zip.ts'), import.meta.url),
    tsImport(source('archives/policy.ts'), import.meta.url),
    tsImport(source('formats/pdf.ts'), import.meta.url),
    tsImport(source('formats/docx.ts'), import.meta.url),
  ])
  helpers = { fixtures, archives, zip, policy, pdf, docx,
    sharp: requireApi('sharp'), pdfLib: requireApi('pdf-lib'), xml: requireApi('@xmldom/xmldom') }
  return helpers
}

async function archiveParts(bytes, h) {
  const budget = new h.policy.Budget()
  const parts = new Map()
  for (const entry of h.zip.parseZip(Buffer.from(bytes), budget)) {
    if (entry.kind === 'file') parts.set(entry.name, await h.zip.decodeEntry(Buffer.from(bytes), entry, budget))
  }
  return parts
}

async function fixture(type, marker) {
  if (type === 'md') return Buffer.from(`# FIL-15 smoke\n\nReplace this line: ${marker}\n\nUntouched: KEEP_ME\n`)
  const h = await fileHelpers()
  if (type === 'png') {
    const pixels = Buffer.alloc(marker.length * 3 + 6)
    for (let i = 0; i < marker.length; i++) pixels[i * 3] = marker.charCodeAt(i)
    pixels.fill(77, marker.length * 3)
    return h.sharp(pixels, { raw: { width: marker.length + 2, height: 1, channels: 3 } }).png().toBuffer()
  }
  if (type === 'pdf') {
    const document = await h.pdfLib.PDFDocument.create()
    const page = document.addPage([612, 792])
    page.drawText(marker, { x: 48, y: 744 })
    page.drawText('Untouched: KEEP_ME', { x: 48, y: 720 })
    return Buffer.from(await document.save())
  }
  if (type === 'docx') return h.fixtures.docx(`<q:p><q:r><q:t>${marker}</q:t></q:r></q:p><q:p><q:r><q:t>Untouched: KEEP_ME</q:t></q:r></q:p>`)
  return h.fixtures.zip({ 'edit.txt': marker, 'untouched.txt': 'Untouched: KEEP_ME' })
}

async function inspect(type, bytes, scratch) {
  if (type === 'md') return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), untouched: bytes.includes('Untouched: KEEP_ME') }
  const h = await fileHelpers()
  if (type === 'png') {
    const { data, info } = await h.sharp(bytes).raw().toBuffer({ resolveWithObject: true })
    const marker = Array.from({ length: info.width - 2 }, (_, i) => String.fromCharCode(data[i * info.channels])).join('')
    return { text: marker, untouched: [...data.subarray((info.width - 2) * info.channels)].every((value) => value === 77),
      edited: data[1] === 201 }
  }
  if (type === 'pdf') {
    const parsed = await h.pdf.readPdf(bytes)
    const document = await h.pdfLib.PDFDocument.load(bytes)
    return { text: parsed.text, untouched: parsed.text.includes('Untouched: KEEP_ME'), edited: document.getPageCount() === 2 }
  }
  const parts = await archiveParts(bytes, h)
  if (type === 'zip') return { text: parts.get('edit.txt')?.toString('utf8') ?? '',
    untouched: parts.get('untouched.txt')?.toString('utf8') === 'Untouched: KEEP_ME' }
  const document = new h.xml.DOMParser({ onError() { throw new Error('Invalid DOCX XML') } })
    .parseFromString(parts.get('word/document.xml')?.toString('utf8') ?? '', 'application/xml')
  const text = Array.from(document.getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't'))
    .map((node) => node.textContent).join('\n')
  const read = await h.docx.readDocx(bytes, scratch)
  return { text: `${text}\n${read.text}`, untouched: text.includes('Untouched: KEEP_ME')
    && parts.get('docProps/custom.xml')?.toString('utf8') === h.fixtures.docxParts()['docProps/custom.xml'] }
}

async function editBinary(type, bytes, editMarker, scratch) {
  const h = await fileHelpers()
  if (type === 'png') {
    const { data, info } = await h.sharp(bytes).raw().toBuffer({ resolveWithObject: true })
    data[1] = 201
    return h.sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } }).png().toBuffer()
  }
  if (type === 'pdf') return Buffer.from(await h.pdf.editPdf(bytes, { kind: 'append_text', text: editMarker }))
  if (type === 'docx') return Buffer.from(await h.docx.editDocx(bytes, { kind: 'append_text', text: editMarker }, scratch))
  const parts = await archiveParts(bytes, h)
  parts.set('edit.txt', Buffer.from(editMarker))
  return h.zip.packEntries([...parts].map(([name, value]) => ({ name, bytes: value })), new h.policy.Budget())
}

function argumentsFrom(argv) {
  const value = { codex: 'codex', model: undefined, output: undefined, type: 'md', timeoutMs: 180_000 }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i], next = argv[++i]
    if (!next) throw new Error(`A value is required for ${name}`)
    if (name === '--codex') value.codex = next
    else if (name === '--model') value.model = next
    else if (name === '--output') value.output = resolve(next)
    else if (name === '--type') value.type = next
    else if (name === '--timeout-ms') value.timeoutMs = Number(next)
    else throw new Error(`Unknown argument: ${name}`)
  }
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600_000) throw new Error('Invalid timeout')
  if (![...types, 'all'].includes(value.type)) throw new Error('Invalid type')
  if (value.type === 'all' && value.output) throw new Error('--output is only available for one type')
  return value
}

// Native ChatGPT authentication can use HOME/CODEX_HOME. Application, database,
// worker and Operator credentials are never inherited or copied into the child.
function nativeEnvironment() {
  const env = { NO_COLOR: '1' }
  for (const key of ['HOME', 'USERPROFILE', 'PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'CODEX_HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return env
}

async function smokeOne(options, env, version, stdioArguments, type) {
  const directory = await mkdtemp(join(tmpdir(), 'fil15-native-smoke-'))
  const inputPath = join(directory, `input.${type}`), workingPath = join(directory, `working.${type}`)
  const marker = `FIL15_${randomUUID().replaceAll('-', '')}`
  const editMarker = `FIL15_EDITED_${randomUUID().replaceAll('-', '')}`
  const original = await fixture(type, marker)
  const inputSha256 = sha256(original)
  const output = options.output ?? resolve(`fil15-smoke-${randomUUID()}.${type}`)
  let child, reader, closed, exited = false, copyCreated = false, publicationRequested = false, edited = false, markerRead = false
  let threadId, activeTurnId, starting = false
  const staged = [], operations = new Map(), callbacks = new Set()
  let nextId = 0, fatal
  let resolveTerminal, rejectTerminal
  const terminal = new Promise((done, failed) => { resolveTerminal = done; rejectTerminal = failed })
  // Attach rejection handler immediately: a disconnect may precede awaiting terminal.
  void terminal.catch(() => {})
  const fail = (error) => {
    if (fatal) return
    fatal = error instanceof Error ? error : new Error('Native smoke failed')
    rejectTerminal(fatal)
    for (const pending of operations.values()) { clearTimeout(pending.timer); pending.reject(fatal) }
    operations.clear()
  }
  const write = (message) => {
    if (fatal) throw fatal
    child.stdin.write(JSON.stringify(message) + '\n', (error) => { if (error) fail(error) })
  }
  const request = (method, params) => new Promise((done, failed) => {
    const id = ++nextId
    const timer = setTimeout(() => { operations.delete(id); failed(new Error(`${method} timed out; not replayed`)) }, 30_000)
    operations.set(id, { resolve: done, reject: failed, timer })
    try { write({ id, method, params }) } catch (error) { clearTimeout(timer); operations.delete(id); failed(error) }
  })
  const result = (text, success = true) => ({ success, contentItems: [{ type: 'inputText', text }] })
  const handleTool = async (frame) => {
    const p = frame.params
    if (!p || p.threadId !== threadId || p.turnId !== activeTurnId || p.namespace != null
      || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
      write({ id: frame.id, result: result('Wrong native turn or invalid input.', false) }); return
    }
    const a = p.arguments
    if (p.tool === 'files_create_working_copy' && Object.keys(a).length === 0) {
      if (!copyCreated) { await writeFile(workingPath, original, { flag: 'wx', mode: 0o600 }); copyCreated = true }
      write({ id: frame.id, result: result(JSON.stringify({ artifactId: 'smoke-working-copy', path: workingPath })) })
    } else if (p.tool === 'files_read_marker' && type !== 'md' && Object.keys(a).length === 0) {
      const parsed = await inspect(type, await readFile(inputPath), directory)
      if (!parsed.text.includes(marker) || !parsed.untouched) throw new Error('Input marker could not be read')
      markerRead = true
      write({ id: frame.id, result: result(JSON.stringify({ marker, untouched: parsed.untouched })) })
    } else if (p.tool === 'files_edit_working_copy' && type !== 'md' && copyCreated && markerRead && !edited
      && Object.keys(a).length === 1 && a.marker === marker) {
      const before = await readFile(workingPath)
      if (sha256(before) !== inputSha256) throw new Error('Working copy changed before edit')
      const bytes = await editBinary(type, before, editMarker, directory)
      await writeFile(workingPath, bytes)
      edited = true
      write({ id: frame.id, result: result(JSON.stringify({ artifactId: 'smoke-working-copy', edit: editMarker })) })
    } else if (p.tool === 'files_publish_result' && copyCreated && (type === 'md' || edited)
      && Object.keys(a).length === 1 && a.artifactId === 'smoke-working-copy') {
      publicationRequested = true
      write({ id: frame.id, result: result('Fixture publication requested. The runner verifies the completed working copy after native process exit.') })
    } else write({ id: frame.id, result: result('Only the registered smoke artifact is supported.', false) })
  }
  const routeTool = (frame) => {
    const task = handleTool(frame).catch(fail)
    callbacks.add(task); void task.finally(() => callbacks.delete(task))
  }
  const stop = async () => {
    if (!child || exited) return
    child.stdin.end()
    const force = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM') } catch { /* Already exited. */ }
    }, 1000)
    const kill = setTimeout(() => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL') } catch { /* Already exited. */ }
    }, 3000)
    try { await closed } finally { clearTimeout(force); clearTimeout(kill) }
  }
  let deadline, model
  try {
    await writeFile(inputPath, original, { mode: 0o400, flag: 'wx' })
    child = spawn(options.codex, ['app-server', ...stdioArguments,
      '-c', 'mcp_servers.graphql-app.enabled=false',
      '-c', 'mcp_servers.graphql-operator.enabled=false'],
    { cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    child.stderr.resume()
    closed = new Promise((done) => {
      child.once('error', (error) => { fail(error); done() })
      child.once('close', () => { exited = true; if (!publicationRequested) fail(new Error('Native process ended before publication')); done() })
    })
    deadline = setTimeout(() => { fail(new Error('Smoke timed out; input was not replayed')); void stop() }, options.timeoutMs)
    reader = (async () => {
      for await (const line of createInterface({ input: child.stdout })) {
        if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error('Native frame exceeds smoke limit')
        const frame = JSON.parse(line)
        if (Object.hasOwn(frame, 'id') && frame.method) {
          if (frame.method === 'item/tool/call') {
            if (starting && !activeTurnId) {
              if (staged.length >= 16) throw new Error('Too many pre-ack callbacks')
              staged.push(frame)
            } else routeTool(frame)
          } else {
            write({ id: frame.id, error: { code: -32601, message: 'Unsupported by file smoke' } })
            fail(new Error(`Unexpected native interaction: ${frame.method}`))
          }
        } else if (Object.hasOwn(frame, 'id')) {
          const pending = operations.get(frame.id)
          if (!pending) continue
          operations.delete(frame.id); clearTimeout(pending.timer)
          if (frame.error) pending.reject(new Error('Native request was rejected; not replayed'))
          else pending.resolve(frame.result)
        } else if (frame.method === 'turn/completed') {
          if (frame.params?.threadId !== threadId) continue
          if (activeTurnId && frame.params.turn?.id !== activeTurnId) continue
          if (frame.params.turn?.status !== 'completed') fail(new Error('Native turn did not complete successfully'))
          else resolveTerminal(frame.params.turn.id)
        }
      }
    })().catch(fail)
    await request('initialize', { clientInfo: { name: 'fil15-smoke', version: '0.1.0' }, capabilities: { experimentalApi: true } })
    write({ method: 'initialized' })
    const configuration = await request('config/read', { includeLayers: false, cwd: directory })
    model = options.model ?? configuration.config?.model
    if (typeof model !== 'string' || !model) model = undefined
    const started = await request('thread/start', {
      cwd: directory, runtimeWorkspaceRoots: [directory], sandbox: 'workspace-write', approvalPolicy: 'never',
      ...(model ? { model } : {}), ephemeral: true,
      config: { 'mcp_servers.graphql-app.enabled': false,
        'mcp_servers.graphql-operator.enabled': false,
        sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true },
        shell_environment_policy: { inherit: 'none', set: { PATH: env.PATH ?? '' } } },
      dynamicTools: [
        { type: 'function', name: 'files_create_working_copy', description: `Create the registered temporary working.${type} copy of input.${type}.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, deferLoading: false },
        ...(type === 'md' ? [] : [
          { type: 'function', name: 'files_read_marker', description: `Parse input.${type} and return its encoded marker.`,
            inputSchema: { type: 'object', properties: {}, additionalProperties: false }, deferLoading: false },
          { type: 'function', name: 'files_edit_working_copy', description: `Apply the ${type} fixture edit to the registered working copy using the marker read from input.`,
            inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false }, deferLoading: false },
        ]),
        { type: 'function', name: 'files_publish_result', description: 'Request publication of the edited smoke working copy. Finish editing before calling.',
          inputSchema: { type: 'object', properties: { artifactId: { type: 'string', enum: ['smoke-working-copy'] } },
            required: ['artifactId'], additionalProperties: false }, deferLoading: false },
      ],
    })
    threadId = started.thread?.id
    if (typeof threadId !== 'string' || !threadId) throw new Error('No native thread identity')
    starting = true
    const instruction = type === 'md'
      ? `Read the attached Markdown at ${JSON.stringify(inputPath)}. Call files_create_working_copy, then edit the returned working copy directly with your native file tools: replace the entire line "Replace this line: ${marker}" with ${JSON.stringify(editMarker)}. Preserve the heading and untouched line. Call files_publish_result with the registered artifact ID and finish with one short sentence.`
      : `Read the attached ${type.toUpperCase()} at ${JSON.stringify(inputPath)} by calling files_read_marker. Call files_create_working_copy, then call files_edit_working_copy with the exact marker you read. Call files_publish_result with the registered artifact ID and finish with one short sentence.`
    const turn = await request('turn/start', { threadId, clientUserMessageId: randomUUID(), input: [{ type: 'text', text_elements: [],
      text: `${instruction} Do not modify the input, launch background writers, access unrelated paths, or request broader permissions.` }] })
    activeTurnId = turn.turn?.id; starting = false
    if (typeof activeTurnId !== 'string' || !activeTurnId) throw new Error('No native turn identity')
    for (const frame of staged.splice(0)) routeTool(frame)
    const completedTurn = await terminal
    if (completedTurn !== activeTurnId || !publicationRequested || (type !== 'md' && !edited)) throw new Error('No completed edit and publication in the exact native turn')
    await Promise.all([...callbacks])
    await stop(); await reader
    if (fatal) throw fatal

    const file = await lstat(workingPath)
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 8 * 1024 * 1024
      || await realpath(workingPath) !== workingPath) throw new Error('Invalid working-copy fixture')
    const descriptor = await open(workingPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    let bytes
    try {
      const current = await descriptor.stat()
      if (current.ino !== file.ino || current.dev !== file.dev || current.size !== file.size) throw new Error('Working copy changed')
      const buffer = Buffer.alloc(file.size + 1)
      let count = 0
      while (count < buffer.length) {
        const chunk = await descriptor.read(buffer, count, buffer.length - count, count)
        if (!chunk.bytesRead) break
        count += chunk.bytesRead
      }
      const after = await descriptor.stat()
      if (count !== file.size || after.size !== file.size || after.mtimeMs !== current.mtimeMs
        || after.ctimeMs !== current.ctimeMs) throw new Error('Working copy changed during verification')
      bytes = buffer.subarray(0, count)
    } finally { await descriptor.close() }
    const parsed = await inspect(type, bytes, directory)
    const validEdit = type === 'png' ? parsed.edited && parsed.text.includes(marker)
      : parsed.text.includes(editMarker) && (type !== 'md' || (parsed.text.startsWith('# FIL-15 smoke\n')
        && !parsed.text.includes(`Replace this line: ${marker}`))) && (type !== 'pdf' || parsed.edited)
    if (!validEdit || !parsed.untouched) throw new Error(`${type} edit or untouched content did not verify`)
    if (sha256(await readFile(inputPath)) !== inputSha256) throw new Error('Original input sha256 changed')
    await writeFile(output, bytes, { mode: 0o600, flag: 'wx' })
    return { type, status: 'passed', codexVersion: version, model: model ?? started.thread?.model ?? turn.turn?.model ?? null,
      inputSha256, outputSha256: sha256(bytes), output, threadId, turnId: activeTurnId }
  } catch (error) {
    if (error instanceof Error) { error.inputSha256 = inputSha256; error.model = model }
    throw error
  } finally {
    clearTimeout(deadline)
    await stop(); await reader
    for (const pending of operations.values()) clearTimeout(pending.timer)
    await rm(directory, { recursive: true, force: true })
  }
}

async function smoke(argv) {
  const options = argumentsFrom(argv), env = nativeEnvironment()
  let version, stdioArguments
  try {
    const identity = await exec(options.codex, ['--version'], { env, timeout: 10_000, maxBuffer: 4096 })
    version = (identity.stdout || identity.stderr).trim()
    const minor = /^codex-cli 0\.(\d+)\.\d+$/.exec(version)?.[1]
    if (!minor || Number(minor) < 157) throw new Error(`This native-only smoke requires codex-cli 0.157 or later; found ${version}`)
    const help = await exec(options.codex, ['app-server', '--help'], { env, timeout: 10_000, maxBuffer: 65_536 })
    const helpText = `${help.stdout}\n${help.stderr}`
    stdioArguments = helpText.includes('--stdio') ? ['--stdio']
      : helpText.includes('--listen') && helpText.includes('stdio://') ? ['--listen', 'stdio://'] : undefined
    if (!stdioArguments) throw new Error('Could not verify a stdio app-server option from this installation')
    const login = await exec(options.codex, ['login', 'status'], { env, timeout: 10_000, maxBuffer: 16_384 })
    if (!`${login.stdout}\n${login.stderr}`.includes('Logged in using ChatGPT')) throw new Error('Native ChatGPT login is required')
  } catch (error) {
    for (const type of options.type === 'all' ? types : [options.type]) {
      console.log(JSON.stringify({ type, status: 'failed', codexVersion: version ?? null, model: options.model ?? null,
        inputSha256: null, outputSha256: null, error: error instanceof Error ? error.message : 'unknown error' }))
    }
    process.exitCode = 1
    return
  }
  for (const type of options.type === 'all' ? types : [options.type]) {
    try { console.log(JSON.stringify(await smokeOne(options, env, version, stdioArguments, type))) }
    catch (error) {
      console.log(JSON.stringify({ type, status: 'failed', codexVersion: version, model: error instanceof Error ? error.model ?? options.model ?? null : options.model ?? null,
        inputSha256: error instanceof Error ? error.inputSha256 ?? null : null, outputSha256: null,
        error: error instanceof Error ? error.message : 'unknown error' }))
      process.exitCode = 1
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smoke(process.argv.slice(2)).catch((error) => {
    console.error(`FIL-15 smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode = 1
  })
}
