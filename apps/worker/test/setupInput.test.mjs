import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable,Writable } from 'node:stream';
import { readPrivateEnrollmentCode } from '../src/setupInput.mjs';
test('private setup pipe is single-line bounded and never echoed',async()=>{
  const chunks=[],output=new Writable({write(chunk,_encoding,done){chunks.push(chunk);done();}});
  assert.equal(await readPrivateEnrollmentCode({input:Readable.from(['GQLWE1.private-code\n']),output}),'GQLWE1.private-code');
  assert.equal(Buffer.concat(chunks).length,0);
  await assert.rejects(readPrivateEnrollmentCode({input:Readable.from(['a'.repeat(8193)]),output}),/setup_code_invalid/);
  await assert.rejects(readPrivateEnrollmentCode({input:Readable.from(['one\ntwo']),output}),/setup_code_invalid/);
});
