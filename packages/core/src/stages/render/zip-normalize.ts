/**
 * Rewrites a ZIP (the DOCX package) with fixed timestamps so identical input yields identical bytes.
 * `docx` stamps entry times and core.xml created/modified with the current time. No extra dependency:
 * uses node:zlib only.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (1 << 5) | 1; // 1980-01-01
const FIXED_ISO = "2000-01-01T00:00:00Z";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: Uint8Array;
  data: Uint8Array;
}

function readEntries(zip: Uint8Array): Entry[] {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip: end of central directory not found");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("zip: bad central directory");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = zip.slice(p + 46, p + 46 + nameLen);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const body = zip.subarray(start, start + csize);
    const data = method === 0 ? body.slice() : new Uint8Array(inflateRawSync(body));
    entries.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

export function normalizeZip(zip: Uint8Array): Uint8Array {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: number[][] = [];
  let offset = 0;
  for (const e of readEntries(zip)) {
    let data = e.data;
    if (dec.decode(e.name) === "docProps/core.xml") {
      data = enc.encode(dec.decode(data).replace(/(<dcterms:(?:created|modified)[^>]*>)[^<]*(<\/dcterms:)/g, `$1${FIXED_ISO}$2`));
    }
    const comp = new Uint8Array(deflateRawSync(data, { level: 9 }));
    const crc = crc32(data);
    const header = [...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(FIXED_DOS_TIME), ...u16(FIXED_DOS_DATE), ...u32(crc), ...u32(comp.length), ...u32(data.length), ...u16(e.name.length), ...u16(0)];
    chunks.push(new Uint8Array(header), e.name, comp);
    central.push([...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(8), ...u16(FIXED_DOS_TIME), ...u16(FIXED_DOS_DATE), ...u32(crc), ...u32(comp.length), ...u32(data.length), ...u16(e.name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...e.name]);
    offset += header.length + e.name.length + comp.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    chunks.push(new Uint8Array(c));
    cdSize += c.length;
  }
  chunks.push(new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(central.length), ...u16(central.length), ...u32(cdSize), ...u32(cdStart), ...u16(0)]));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
