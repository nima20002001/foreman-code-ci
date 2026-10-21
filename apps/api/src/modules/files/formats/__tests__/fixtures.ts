import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { Budget } from "../../archives/policy.js";
import { packEntries } from "../../archives/zip.js";

/** Tiny fixtures authored here; no downloads, Office installation, or foreign runtime. */
export function zip(parts: Record<string, string | Buffer>): Buffer {
  return packEntries(Object.entries(parts).map(([name, bytes]) => ({ name, bytes: Buffer.from(bytes) })), new Budget());
}
export function docxParts(body = '<q:p><q:pPr><q:keepNext/></q:pPr><q:r><q:t>ORIGINAL &amp; marker</q:t></q:r></q:p>'): Record<string, string | Buffer> {
  return {
    "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><q:document xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:body>${body}<q:sectPr><q:pgSz q:w="12240" q:h="15840"/></q:sectPr></q:body></q:document>`,
    "word/styles.xml": '<q:styles xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:style q:type="paragraph" q:styleId="Original"/></q:styles>',
    "docProps/custom.xml": '<meta><untouched>Do not normalize this part.</untouched></meta>\r\n',
    "word/media/pixel.png": Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex"),
    "word/_rels/document.xml.rels": '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/never-fetch" TargetMode="External"/></Relationships>',
  };
}
export function docx(body?: string): Buffer { return zip(docxParts(body)); }

/** R2 fixture-only RC4 implementation: deliberately weak historical PDF encryption, NOT application crypto. */
function rc4(key: Buffer, bytes: Buffer): Buffer {
  const table = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + table[i]! + key[i % key.length]!) & 255; [table[i], table[j]] = [table[j]!, table[i]!]; }
  const output = Buffer.alloc(bytes.length);
  let i = 0; j = 0;
  for (let n = 0; n < bytes.length; n++) {
    i = (i + 1) & 255; j = (j + table[i]!) & 255;
    [table[i], table[j]] = [table[j]!, table[i]!];
    output[n] = bytes[n]! ^ table[(table[i]! + table[j]!) & 255]!;
  }
  return output;
}
const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const md5 = (bytes: Buffer) => createHash("md5").update(bytes).digest();
const passwordBytes = (password: string) => Buffer.concat([Buffer.from(password, "ascii"), padding]).subarray(0, 32);
interface PdfOptions { scan?: boolean; password?: string; action?: boolean; compressedText?: string }
export function pdfFixture(pages = ["PAGE ONE marker", "PAGE TWO untouched"], options: PdfOptions = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (value: string | Buffer): number => { objects.push(Buffer.from(value)); return objects.length; };
  const set = (id: number, value: string | Buffer) => { objects[id - 1] = Buffer.from(value); };
  const catalog = add(""); const pagesId = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  let key: Buffer | undefined;
  let encryption: { owner: Buffer; user: Buffer; id: Buffer } | undefined;
  if (options.password !== undefined) {
    const owner = rc4(md5(passwordBytes("fixture-owner")).subarray(0, 5), passwordBytes(options.password));
    const permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
    const id = md5(Buffer.from("FIL-06 deterministic encrypted fixture"));
    key = md5(Buffer.concat([passwordBytes(options.password), owner, permissions, id])).subarray(0, 5);
    encryption = { owner, user: rc4(key, padding), id };
  }
  function stream(raw: Buffer, extra = ""): number {
    const id = objects.length + 1;
    let data = raw;
    if (key) {
      const objectId = Buffer.from([id & 255, (id >> 8) & 255, (id >> 16) & 255, 0, 0]);
      data = rc4(md5(Buffer.concat([key, objectId])).subarray(0, Math.min(key.length + 5, 16)), raw);
    }
    add(Buffer.concat([Buffer.from(`<< /Length ${data.length} ${extra} >>\nstream\n`), data, Buffer.from("\nendstream")]));
    return id;
  }
  const kids: number[] = [];
  for (const marker of pages) {
    const page = add(""); kids.push(page);
    let contents: number; let resources = `<< /Font << /F1 ${font} 0 R >> >>`;
    if (options.scan) {
      const image = stream(Buffer.from([128]), "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8");
      contents = stream(Buffer.from("q 100 0 0 100 48 600 cm /Im0 Do Q"));
      resources = `<< /XObject << /Im0 ${image} 0 R >> >>`;
    } else {
      const text = options.compressedText ?? marker;
      const runs = options.compressedText ? text.match(/[\s\S]{1,70}/g) ?? [] : [text];
      const raw = Buffer.from(`BT /F1 12 Tf ${runs.map((run) => `1 0 0 1 48 744 Tm (${run.replace(/[\\()]/g, "\\$&")}) Tj`).join(" ")} ET`, "ascii");
      contents = options.compressedText ? stream(deflateSync(raw), "/Filter /FlateDecode") : stream(raw);
    }
    set(page, `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${contents} 0 R >>`);
  }
  let action = "";
  if (options.action) {
    const actionId = add('<< /S /JavaScript /JS (throw new Error("DOCUMENT_MUST_NEVER_EXECUTE");) >>');
    action = ` /OpenAction ${actionId} 0 R`;
  }
  set(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R${action} >>`);
  set(pagesId, `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((id) => `${id} 0 R`).join(" ")}] >>`);
  let trailer = ` /Root ${catalog} 0 R`;
  if (encryption) {
    const encryptId = add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${encryption.owner.toString("hex")}> /U <${encryption.user.toString("hex")}> >>`);
    trailer += ` /Encrypt ${encryptId} 0 R /ID [<${encryption.id.toString("hex")}> <${encryption.id.toString("hex")}>]`;
  }
  const pieces: Buffer[] = [Buffer.from("%PDF-1.7\n%\xff\xff\xff\xff\n", "latin1")];
  const offsets = [0]; let offset = pieces[0]!.length;
  objects.forEach((object, index) => {
    offsets.push(offset); const piece = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    pieces.push(piece); offset += piece.length;
  });
  const xref = `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length}${trailer} >>\nstartxref\n${offset}\n%%EOF\n`;
  return Buffer.concat([...pieces, Buffer.from(xref)]);
}

/** Minimal CFB directory fixture. Stream names declare encryption; payload is intentionally never decrypted. */
export function officeContainer(encrypted = true): Buffer {
  const bytes = Buffer.alloc(3 * 512);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(bytes);
  bytes.writeUInt16LE(0x003e, 24); bytes.writeUInt16LE(3, 26); bytes.writeUInt16LE(0xfffe, 28);
  bytes.writeUInt16LE(9, 30); bytes.writeUInt16LE(6, 32); bytes.writeUInt32LE(1, 44); bytes.writeUInt32LE(0, 48);
  bytes.writeUInt32LE(4096, 56); bytes.writeUInt32LE(0xfffffffe, 60); bytes.writeUInt32LE(0xfffffffe, 68);
  bytes.fill(255, 76, 512); bytes.writeUInt32LE(1, 76);
  function item(index: number, name: string, type: number, right = 0xffffffff, child = 0xffffffff): void {
    const offset = 512 + index * 128;
    Buffer.from(`${name}\0`, "utf16le").copy(bytes, offset);
    bytes.writeUInt16LE((name.length + 1) * 2, offset + 64); bytes[offset + 66] = type; bytes[offset + 67] = 1;
    bytes.writeUInt32LE(0xffffffff, offset + 68); bytes.writeUInt32LE(right, offset + 72); bytes.writeUInt32LE(child, offset + 76);
    bytes.writeUInt32LE(0xfffffffe, offset + 116);
  }
  item(0, "Root Entry", 5, 0xffffffff, 1);
  item(1, encrypted ? "EncryptionInfo" : "WordDocument", 2, encrypted ? 2 : 0xffffffff);
  if (encrypted) item(2, "EncryptedPackage", 2);
  bytes.fill(255, 1024); bytes.writeUInt32LE(0xfffffffe, 1024); bytes.writeUInt32LE(0xfffffffd, 1028);
  return bytes;
}
