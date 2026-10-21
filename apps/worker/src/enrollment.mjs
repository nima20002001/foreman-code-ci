import { request as httpsRequest } from 'node:https';
import { deviceTlsOptions } from '../../../packages/contracts/src/deviceTlsNode.ts';
import { verifiedWorkerEnrollmentCode } from '../../../packages/contracts/src/deviceSetupNode.ts';
import { randomBytes, sign } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { WorkerEnrollmentInputSchema, DevicePairingResultSchema } from '../../../packages/contracts/src/deviceIdentity.ts';
import { pairingProof, verifyMainEnrollmentProof, persistWorkerPairing, loadWorkerPairing } from '../../../packages/contracts/src/deviceIdentityNode.ts';
import { requirePrivateDirectory, WorkerError } from './diagnostics.mjs';
import { ensurePairedManagedSetup } from './managedSetup.mjs';
import { acquireWorkerLock } from './runtime.mjs';
import { ignoreError } from '../../api/src/modules/diagnostics/ignoredError.ts';

const retryHint = 'Keep the original state directory, identity, enrollment file and requestId. Retry the same pair command; do not create a new identity or requestId.';
const recoveryHints = {
  setup_code_invalid: 'Paste the complete approved enrollment code through private input; never place it in command arguments.',
  setup_code_identity_mismatch: 'The code belongs to another companion identity. Ask the main to approve this companion public request code.',
  setup_code_expired: 'The original grant expired. Check the original approval with the main; do not replace identity automatically.',
  setup_code_cancelled: 'Private enrollment entry cancelled; the original identity remains unchanged.',
  pairing_file_missing: 'Provide the existing private enrollment file at the absolute --enrollment-file path.',
  pairing_file_unreadable: 'Check ownership and read access to the existing enrollment file.',
  private_enrollment_file_required: 'Use an owned regular file, mode 0600, at most 16384 bytes; do not print its contents.',
  pairing_file_json_invalid: 'Correct the enrollment file JSON locally; preserve its original grant and requestId.',
  pairing_file_schema_invalid: 'Check mainId, mainPublicKeyFingerprint, endpoint, grant and requestId against the enrollment format; preserve the original requestId.',
  enrollment_endpoint_invalid: 'Use the approved wss:// main endpoint with path /device/connect and no credentials, query or fragment.',
  pairing_main_unreachable: 'Check the approved main endpoint, TLS trust and connectivity, then retry with the same enrollment file and requestId.',
  pairing_challenge_response_invalid: 'Check the selected main version and device listener before retrying with the same enrollment file.',
  wrong_main_proof: 'Verify the selected main and pinned fingerprint with the main administrator before retrying. Do not change the pin to bypass this check.',
  enrollment_identity_mismatch: `The response does not match the original identity. Verify the selected main before retrying. ${retryHint}`,
  pairing_outcome_unknown: retryHint,
  pairing_persistence_failed: `The main may have accepted pairing but local persistence failed. Check state-directory access. ${retryHint}`,
  already_paired: 'Re-enrollment must use the existing Main and pinned identity.',
  managed_setup_incomplete: 'The computer is paired, but managed runtime setup is incomplete. Read doctor for the setup failure and restart the Worker after resolving it.',
  worker_already_running: 'Stop the background Worker, then retry with the same enrollment code.',
};

// Only fixed local codes and validated HTTP status numbers reach terminal output.
export function pairingErrorMessage(error) {
  if (error?.code === 'pairing_http_rejected' && /^enrollment_http_[1-5][0-9]{2}$/.test(error.reason)) {
    const status = Number(error.reason.slice(-3));
    const hint = [401, 403].includes(status)
      ? 'Ask the main administrator to check the original grant, installation authorization and expiry; do not replace identity or requestId.'
      : status === 409 ? 'Verify the selected main and original requestId with the main administrator.'
        : 'Check the enrollment input and selected main device listener before retrying the original request.';
    return `pairing_http_rejected (HTTP ${status}): ${hint}`;
  }
  const hint = Object.hasOwn(recoveryHints, error?.code) ? recoveryHints[error.code] : null;
  const reason = ['enrollment_transport_failed', 'enrollment_response_invalid', 'enrollment_response_too_large', 'pairing_response_schema_invalid'].includes(error?.reason) || /^enrollment_http_[1-5][0-9]{2}$/.test(error?.reason) ? ` (${error.reason})` : '';
  if (hint) return `${error.code}${reason}: ${hint}`;
  return `pairing_failed: Read doctor and check the installation and private state directory. ${retryHint}`;
}

export async function boundedPost(url, body, fetchRequest = fetch) {
  let response;
  try { response = await fetchRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new WorkerError('enrollment_transport_failed'); }
  if (!response.ok) {
    await response.body?.cancel().catch(ignoreError('devices', 'cancel enrollment response', { status: response.status }));
    throw new WorkerError(`enrollment_http_${response.status}`);
  }
  if (!response.body) throw new WorkerError('enrollment_response_invalid');
  let size = 0; const chunks = [];
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > 16_384) throw new WorkerError('enrollment_response_too_large');
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) { throw error instanceof WorkerError ? error : new WorkerError('enrollment_transport_failed'); }
  finally { await reader.cancel().catch(ignoreError('devices', 'cancel enrollment reader')); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new WorkerError('enrollment_response_invalid'); }
}

/** App-specific CA is passed only to this request, with normal TLS hostname and
 * chain validation. No redirects or response text reaches diagnostics. */
export function scopedEnrollmentPost(tlsTrust,requestFactory=httpsRequest) {
  const tls=deviceTlsOptions(tlsTrust);
  return (url,body)=>new Promise((resolve,reject)=>{
    const bytes=Buffer.from(JSON.stringify(body));
    const request=requestFactory(url,{method:'POST',...tls,headers:{'content-type':'application/json','content-length':bytes.length},signal:AbortSignal.timeout(10000)},response=>{
      if(!response.statusCode||response.statusCode<200||response.statusCode>=300){response.destroy();reject(new WorkerError(`enrollment_http_${response.statusCode??500}`));return;}
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>16384){response.destroy();reject(new WorkerError('enrollment_response_too_large'));}else chunks.push(Buffer.from(chunk));});
      response.once('error',()=>reject(new WorkerError('enrollment_transport_failed')));
      response.once('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new WorkerError('enrollment_response_invalid'));}});
    });
    request.once('error',()=>reject(new WorkerError('enrollment_transport_failed')));request.end(bytes);
  });
}

async function enrollmentPost(post, url, body, pairing) {
  try { return await post(url, body); }
  catch (error) {
    const status = /^enrollment_http_[1-5][0-9]{2}$/.test(error?.code) ? Number(error.code.slice(-3)) : null;
    const definiteRejection = status !== null && status < 500 && ![408, 429].includes(status);
    const code = definiteRejection ? 'pairing_http_rejected' : pairing ? 'pairing_outcome_unknown'
      : status !== null || error?.code === 'enrollment_transport_failed' || !(error instanceof WorkerError) ? 'pairing_main_unreachable' : 'pairing_challenge_response_invalid';
    const failure = new WorkerError(code);
    failure.reason = error instanceof WorkerError ? error.code : 'enrollment_transport_failed';
    throw failure;
  }
}

export async function enrollWorker({ stateDirectory, identity, enrollmentFile, appVersion, home, post = boundedPost }) {
  let file, contents;
  try { file = await lstat(enrollmentFile); }
  catch (error) { throw new WorkerError(error.code === 'ENOENT' ? 'pairing_file_missing' : 'pairing_file_unreadable', undefined, { cause: error }); }
  if (!file.isFile() || file.uid !== process.getuid() || (file.mode & 0o077) || file.size > 16_384) throw new WorkerError('private_enrollment_file_required');
  try { contents = await readFile(enrollmentFile, 'utf8'); }
  catch { throw new WorkerError('pairing_file_unreadable'); }
  let json;
  try { json = JSON.parse(contents); }
  catch { throw new WorkerError('pairing_file_json_invalid'); }
  const parsed = WorkerEnrollmentInputSchema.safeParse(json);
  if (!parsed.success) throw new WorkerError('pairing_file_schema_invalid');
  return enrollWorkerInput({stateDirectory,identity,enrollment:parsed.data,appVersion,post,home});
}
export async function enrollWorkerCode({stateDirectory,identity,enrollmentCode,appVersion,post,home}) {
  let code;
  try{code=verifiedWorkerEnrollmentCode(enrollmentCode,identity);}
  catch(error){throw new WorkerError(error.message==='DEVICE_SETUP_IDENTITY_MISMATCH'?'setup_code_identity_mismatch':error.message==='DEVICE_SETUP_CODE_EXPIRED'?'setup_code_expired':'setup_code_invalid', undefined, { cause: error });}
  return enrollWorkerInput({stateDirectory,identity,enrollment:code.enrollment,appVersion,post:post??(code.tlsTrust?scopedEnrollmentPost(code.tlsTrust):boundedPost),tlsTrust:code.tlsTrust,home});
}
async function enrollWorkerInput({stateDirectory,identity,enrollment,appVersion,post,tlsTrust,home}) {
  await requirePrivateDirectory(stateDirectory);
  stateDirectory = await realpath(stateDirectory);
  const unlock = await acquireWorkerLock(stateDirectory);
  try {
    let previous;
    try { previous = await loadWorkerPairing(stateDirectory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && (previous.mainId !== enrollment.mainId
      || previous.mainPublicKeyFingerprint !== enrollment.mainPublicKeyFingerprint)) {
      throw new WorkerError('already_paired');
    }
    const endpoint = new URL(enrollment.endpoint);
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.pathname !== '/device/connect' || endpoint.search || endpoint.hash) throw new WorkerError('enrollment_endpoint_invalid');
    const http = new URL(endpoint);
    http.protocol = 'https:';
    const proofRequest = { audience: 'graphql-worker-main-enrollment-v1', mainId: enrollment.mainId, workerInstallationId: identity.workerInstallationId, nonce: randomBytes(32).toString('base64url'), protocolVersion: 1, workerApplicationVersion: appVersion };
    http.pathname = '/device/challenge';
    const proof = await enrollmentPost(post, http.href, proofRequest, false);
    if (!await verifyMainEnrollmentProof(proof, proofRequest, enrollment.mainPublicKeyFingerprint)) throw new WorkerError('wrong_main_proof');
    // Grant and signed enrollment are sent only after a fresh pinned-key proof.
    const request = { mainId: enrollment.mainId, workerInstallationId: identity.workerInstallationId, publicKey: identity.publicKey, grant: enrollment.grant, requestId: enrollment.requestId };
    const signature = sign(null, Buffer.from(pairingProof(request)), identity.privateKey).toString('base64url');
    http.pathname = '/device/pair';
    const parsedResult = DevicePairingResultSchema.safeParse(await enrollmentPost(post, http.href, { ...request, signature }, true));
    if (!parsedResult.success) {
      const failure = new WorkerError('pairing_outcome_unknown');
      failure.reason = 'pairing_response_schema_invalid';
      throw failure;
    }
    const result = parsedResult.data;
    if (result.registration.mainId !== enrollment.mainId || result.registration.workerInstallationId !== identity.workerInstallationId || result.registration.publicKeyFingerprint !== identity.publicKeyFingerprint || result.registration.keyRevision !== identity.keyRevision || result.registration.status !== 'paired') throw new WorkerError('enrollment_identity_mismatch');
    try {
      await persistWorkerPairing(stateDirectory, { formatVersion: 1, mainId: result.registration.mainId,
        deviceId: result.registration.deviceId, workerInstallationId: identity.workerInstallationId,
        keyRevision: result.registration.keyRevision, authorizationRevision: result.registration.authorizationRevision,
        endpoint: enrollment.endpoint, mainPublicKeyFingerprint: enrollment.mainPublicKeyFingerprint,
        credential: result.credential, expiresAt: result.expiresAt, ...(tlsTrust ? { tlsTrust } : {}) });
    } catch (error) {
      throw new WorkerError('pairing_persistence_failed', undefined, { cause: error });
    }
    const pairing = { mainId: result.registration.mainId, deviceId: result.registration.deviceId,
      workerInstallationId: identity.workerInstallationId, keyRevision: result.registration.keyRevision,
      authorizationRevision: result.registration.authorizationRevision };
    const setup = await ensurePairedManagedSetup({ stateDirectory, pairing, home, assertStateOwnership: unlock.assertOwned });
    if (setup.state === 'failed') throw new WorkerError('managed_setup_incomplete', setup.message);
    return { mainId: result.registration.mainId, deviceId: result.registration.deviceId, workerInstallationId: identity.workerInstallationId, authorizationRevision: result.registration.authorizationRevision };
  } finally { await unlock(); }
}
