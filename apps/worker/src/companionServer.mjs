import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { workerPath } from './harnessPath.mjs';
import { requirePrivateDirectory, WorkerError } from './diagnostics.mjs';
import { createCompanionService } from './companionService.mjs';

function cliCommand(stateDirectory, command, input) {
  return new Promise((resolve, reject) => {
    const args = [fileURLToPath(new URL('./cli.mjs', import.meta.url)), command, '--state', stateDirectory];
    if (command === 'pair') args.push('--enrollment-stdin');
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { HOME: process.env.HOME, PATH: workerPath(process.env.HOME ?? '', process.execPath), XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } });
    let output = '', error = '', size = 0;
    const timer = setTimeout(() => child.kill('SIGTERM'), 30_000);
    const collect = (chunk, stderr) => {
      size += chunk.length;
      if (size > 32_768) { child.kill('SIGTERM'); return; }
      if (stderr) error += chunk.toString(); else output += chunk.toString();
    };
    child.stdout.on('data', (chunk) => collect(chunk, false));
    child.stderr.on('data', (chunk) => collect(chunk, true));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new WorkerError('companion_command_failed')); });
    child.on('close', (status) => {
      clearTimeout(timer);
      if (status === 0 && size <= 32_768) resolve(output.trim());
      else {
        const code = error.split(/[:\s(]/, 1)[0];
        reject(new WorkerError(['setup_code_invalid', 'setup_code_identity_mismatch', 'setup_code_expired', 'setup_code_cancelled', 'already_paired', 'wrong_main_proof', 'pairing_main_unreachable', 'pairing_outcome_unknown', 'pairing_http_rejected', 'target_runtime_mismatch'].includes(code) ? code : 'companion_command_failed'));
      }
    });
    child.stdin.end(input ? `${input}\n` : '');
  });
}

async function jsonBody(request) {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new WorkerError('json_required');
  const chunks = await new Promise((resolve, reject) => {
    let size = 0, rejected = false; const bytes = [];
    const timer = setTimeout(() => { rejected = true; reject(new WorkerError('request_timeout')); request.destroy(); }, 5000);
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16_384) { if (!rejected) { rejected = true; clearTimeout(timer); reject(new WorkerError('request_too_large')); } return; }
      bytes.push(chunk);
    });
    request.once('end', () => { clearTimeout(timer); if (!rejected) resolve(bytes); });
    request.once('error', () => { clearTimeout(timer); reject(new WorkerError('request_invalid')); });
    request.once('aborted', () => { clearTimeout(timer); reject(new WorkerError('request_invalid')); });
  });
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WorkerError('request_invalid'); }
}

// Pairing never starts a service. Its separately confirmed enable action can
// install only this user's reviewed unit; GUI close never stops the worker.
export async function createCompanionServer({ stateDirectory, htmlFile = new URL('../artifacts/companion.html', import.meta.url), runCli = (command, input) => cliCommand(stateDirectory, command, input), serviceController = createCompanionService({ home: process.env.HOME ?? '', stateDirectory }), lifetimeMs = 30 * 60_000, readOnly = false,
  manifestFile = new URL('../manifest.json', import.meta.url), installationRoot = join(process.env.HOME ?? '', '.local/lib/graphql-worker') }) {
  await requirePrivateDirectory(stateDirectory);
  const html = await readFile(htmlFile, 'utf8');
  let requiredTarget;
  let sessionManifestSha256;
  const manifestHash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  try {
    const bytes = await readFile(manifestFile);
    requiredTarget = JSON.parse(bytes).target;
    sessionManifestSha256 = manifestHash(bytes);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let trackInstallation = false;
  if (sessionManifestSha256) {
    try {
      await readFile(join(installationRoot, 'current/manifest.json'));
      trackInstallation = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  async function installationStatus() {
    if (!trackInstallation) return { changed: false, target: requiredTarget };
    try {
      const bytes = await readFile(join(installationRoot, 'current/manifest.json'));
      return { changed: manifestHash(bytes) !== sessionManifestSha256, target: JSON.parse(bytes).target };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { changed: true, target: undefined };
    }
  }
  const compatibility = (report, installation) => {
    const keys = ['os', 'osRelease', 'arch', 'libc', 'node'];
    const project = (value) => Object.fromEntries(keys.map((key) => [key, typeof value?.[key] === 'string' ? value[key] : null]));
    const required = project(installation.target), actual = project(report.versions);
    const mismatches = keys.filter((key) => !required[key] || actual[key] !== required[key]);
    return { supported: !installation.changed && mismatches.length === 0, required, actual, mismatches };
  };
  const session = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + lifetimeMs;
  let origin, host, pairing = false, closed = false, timer;
  function respond(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    response.end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host || request.rawHeaders.filter((value, i) => i % 2 === 0 && value.toLowerCase() === 'host').length !== 1) { respond(response, 403, { error: 'host_rejected' }); return; }
    if (closed || Date.now() >= expiresAt) { respond(response, 401, { error: 'session_expired' }); return; }
    if (request.method === 'GET' && request.url === '/') {
      if (request.headers.origin && request.headers.origin !== origin) { respond(response, 403, { error: 'origin_rejected' }); return; }
      const nonce = randomBytes(24).toString('base64url');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      response.end(html.replaceAll('{{CSP_NONCE}}', nonce)); return;
    }
    if (request.method !== 'POST' || !['/api/status', '/api/identity-request', '/api/pair', '/api/close', '/api/service-plan', '/api/service-enable'].includes(request.url)) { respond(response, 404, { error: 'not_found' }); return; }
    if (request.headers.origin !== origin) { respond(response, 403, { error: 'origin_rejected' }); return; }
    const supplied = request.headers['x-graphql-companion-session'];
    if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(session))) { respond(response, 401, { error: 'session_rejected' }); return; }
    try {
      const body = await jsonBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new WorkerError('request_invalid');
      if (request.url === '/api/close') { respond(response, 200, { closed: true }); setImmediate(close); return; }
      const installation = await installationStatus();
      if (request.url === '/api/status') {
        const report = JSON.parse(await runCli('doctor'));
        respond(response, 200, { ...report, compatibility: compatibility(report, installation), installationChanged: installation.changed,
          readOnly, sessionExpiresAt: new Date(expiresAt).toISOString(), serviceControl: 'human-only-confirmation' }); return;
      }
      if (readOnly) { respond(response, 403, { error: 'preview_read_only' }); return; }
      if (installation.changed) throw new WorkerError('companion_installation_changed');
      if (request.url === '/api/service-plan') { respond(response, 200, await serviceController.plan()); return; }
      if (request.url === '/api/service-enable') {
        if (body.confirm !== true || !/^[a-f0-9]{64}$/.test(body.planSha256 ?? '')) throw new WorkerError('service_confirmation_required');
        if (JSON.parse(await runCli('doctor')).pairing !== 'paired') throw new WorkerError('pairing_required');
        respond(response, 200, await serviceController.enable(body.planSha256)); return;
      }
      if (request.url === '/api/identity-request') { respond(response, 200, { code: await runCli('identity-request') }); return; }
      if (typeof body.enrollmentCode !== 'string' || body.enrollmentCode.length > 8192 || !/^[A-Za-z0-9_.-]+$/.test(body.enrollmentCode)) throw new WorkerError('enrollment_code_invalid');
      if (pairing) { respond(response, 409, { error: 'pairing_in_progress' }); return; }
      pairing = true;
      try { await runCli('pair', body.enrollmentCode); respond(response, 200, { paired: true }); }
      finally { pairing = false; }
    } catch (error) {
      const code = error instanceof WorkerError ? error.code : 'companion_command_failed';
      respond(response, code === 'request_too_large' ? 413 : 400, { error: code });
    }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 8;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`; origin = `http://${host}`;
  function close() {
    if (closed) return;
    closed = true; clearTimeout(timer); server.close(); server.closeAllConnections();
  }
  timer = setTimeout(close, lifetimeMs);
  return { origin, url: `${origin}/#session=${session}`, session, close };
}
