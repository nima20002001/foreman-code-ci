import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash,X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
const require=createRequire(new URL('../../api/package.json',import.meta.url));
const {tsImport}=await import(require.resolve('tsx/esm/api'));
const {deviceTlsOptions}=await tsImport('../../../packages/contracts/src/deviceTlsNode.ts',import.meta.url);
const {scopedEnrollmentPost}=await tsImport('../src/enrollment.mjs',import.meta.url);
const certificatePem=rootCertificates.find(pem=>new X509Certificate(pem).ca);
const trust={certificatePem,sha256:createHash('sha256').update(new X509Certificate(certificatePem).raw).digest('hex')};
test('public CA is validated and scoped without weakening hostname/chain defaults',()=>{
  assert.deepEqual(deviceTlsOptions(trust),{rejectUnauthorized:true,ca:certificatePem});
  assert.deepEqual(deviceTlsOptions(),{rejectUnauthorized:true});
  assert.throws(()=>deviceTlsOptions({...trust,sha256:'0'.repeat(64)}),/TRUST_INVALID/);
  assert.throws(()=>deviceTlsOptions({...trust,certificatePem:certificatePem+'\n'+certificatePem}),/TRUST_INVALID/);
});
test('enrollment scoped request retains TLS verification and bounded response without network',async()=>{
  let options,actualUrl;
  const post=scopedEnrollmentPost(trust,(url,configuration,respond)=>{
    options=configuration;actualUrl=url;
    const request=new EventEmitter();request.end=()=>{const response=Readable.from([Buffer.from('{"accepted":true}')]);response.statusCode=200;respond(response);};return request;
  });
  assert.deepEqual(await post('https://192.168.1.12:7443/device/challenge',{nonce:'public'}),{accepted:true});
  assert.equal(actualUrl,'https://192.168.1.12:7443/device/challenge');assert.equal(options.ca,certificatePem);assert.equal(options.rejectUnauthorized,true);
  assert.equal(options.checkServerIdentity,undefined);assert.ok(options.signal); // Node normal SAN/hostname verification remains installed.
});
