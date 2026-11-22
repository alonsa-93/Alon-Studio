import zlib from 'node:zlib';

/**
 * Font files in pure JS: read the family name of a TrueType / OpenType font, and turn WOFF and WOFF2
 * into plain TTF / OTF. The export burns text with libass, which only loads sfnt files from its
 * fonts folder, so every uploaded font is stored as sfnt. Written from the public WOFF 1.0 and
 * WOFF2 specifications (W3C).
 */

export class FontError extends Error {}
const bad = (msg: string): never => {
  throw new FontError(msg);
};

const SFNT_TRUETYPE = 0x00010000;
const SFNT_CFF = 0x4f54544f; // 'OTTO'
const SFNT_APPLE = 0x74727565; // 'true'
const WOFF = 0x774f4646; // 'wOFF'
const WOFF2 = 0x774f4632; // 'wOF2'
const MAX_FONT = 30 * 1024 * 1024;

export type FontFormat = 'ttf' | 'otf' | 'woff' | 'woff2';

export function fontFormat(buf: Buffer): FontFormat | null {
  if (buf.length < 12) return null;
  const tag = buf.readUInt32BE(0);
  if (tag === SFNT_TRUETYPE || tag === SFNT_APPLE) return 'ttf';
  if (tag === SFNT_CFF) return 'otf';
  if (tag === WOFF) return 'woff';
  if (tag === WOFF2) return 'woff2';
  return null;
}

interface Table {
  tag: string;
  data: Buffer;
}

function tagOf(n: number) {
  return String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function checksum(b: Buffer) {
  let sum = 0;
  const n = Math.floor(b.length / 4);
  for (let i = 0; i < n; i++) sum = (sum + b.readUInt32BE(i * 4)) >>> 0;
  if (b.length % 4) {
    const tail = Buffer.alloc(4);
    b.copy(tail, 0, n * 4);
    sum = (sum + tail.readUInt32BE(0)) >>> 0;
  }
  return sum;
}

/** Writes an sfnt: offset table, sorted table records, tables padded to 4 bytes, head checksum fixed. */
function writeSfnt(flavor: number, tables: Table[]): Buffer {
  tables = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const num = tables.length;
  let pow = 1;
  let log = 0;
  while (pow * 2 <= num) {
    pow *= 2;
    log++;
  }
  const headerLen = 12 + 16 * num;
  let total = headerLen;
  for (const t of tables) total += (t.data.length + 3) & ~3;
  const out = Buffer.alloc(total);
  out.writeUInt32BE(flavor >>> 0, 0);
  out.writeUInt16BE(num, 4);
  out.writeUInt16BE(pow * 16, 6);
  out.writeUInt16BE(log, 8);
  out.writeUInt16BE(num * 16 - pow * 16, 10);
  let off = headerLen;
  let headAt = -1;
  tables.forEach((t, i) => {
    const data = Buffer.from(t.data);
    if (t.tag === 'head' && data.length >= 12) {
      data.writeUInt32BE(0, 8);
      headAt = off;
    }
    const rec = 12 + i * 16;
    out.write(t.tag.padEnd(4, ' '), rec, 'latin1');
    out.writeUInt32BE(checksum(data), rec + 4);
    out.writeUInt32BE(off, rec + 8);
    out.writeUInt32BE(data.length, rec + 12);
    data.copy(out, off);
    off += (data.length + 3) & ~3;
  });
  if (headAt >= 0) out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headAt + 8);
  return out;
}

/** The tables of an sfnt (TTF / OTF). */
export function readSfnt(buf: Buffer): { flavor: number; tables: Table[] } {
  const fmt = fontFormat(buf);
  if (fmt !== 'ttf' && fmt !== 'otf') bad('not a TrueType / OpenType font');
  const num = buf.readUInt16BE(4);
  if (num < 1 || num > 200 || 12 + num * 16 > buf.length) bad('damaged font: table directory');
  const tables: Table[] = [];
  for (let i = 0; i < num; i++) {
    const rec = 12 + i * 16;
    const off = buf.readUInt32BE(rec + 8);
    const len = buf.readUInt32BE(rec + 12);
    if (off + len > buf.length) bad('damaged font: table outside the file');
    tables.push({ tag: buf.toString('latin1', rec, rec + 4), data: buf.subarray(off, off + len) });
  }
  return { flavor: buf.readUInt32BE(0), tables };
}

// ---------- WOFF 1.0 ----------

export function woffToSfnt(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.readUInt32BE(0) !== WOFF) bad('not a WOFF font');
  const flavor = buf.readUInt32BE(4);
  const num = buf.readUInt16BE(12);
  const totalSfnt = buf.readUInt32BE(16);
  if (num < 1 || num > 200 || 44 + num * 20 > buf.length || totalSfnt > MAX_FONT) bad('damaged WOFF font');
  const tables: Table[] = [];
  for (let i = 0; i < num; i++) {
    const rec = 44 + i * 20;
    const off = buf.readUInt32BE(rec + 4);
    const comp = buf.readUInt32BE(rec + 8);
    const orig = buf.readUInt32BE(rec + 12);
    if (off + comp > buf.length || orig > MAX_FONT || comp > orig) bad('damaged WOFF font: table');
    const raw = buf.subarray(off, off + comp);
    const data = comp < orig ? zlib.inflateSync(raw, { maxOutputLength: orig }) : Buffer.from(raw);
    if (data.length !== orig) bad('damaged WOFF font: table size');
    tables.push({ tag: buf.toString('latin1', rec, rec + 4), data });
  }
  return writeSfnt(flavor, tables);
}

// ---------- WOFF2 ----------

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

class Reader {
  pos = 0;
  constructor(
    readonly b: Buffer,
    readonly name = 'data',
  ) {}
  need(n: number) {
    if (this.pos + n > this.b.length) bad(`damaged WOFF2 font: ${this.name} ends early`);
  }
  u8() {
    this.need(1);
    return this.b[this.pos++];
  }
  u16() {
    this.need(2);
    const v = this.b.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  i16() {
    this.need(2);
    const v = this.b.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.b.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  bytes(n: number) {
    this.need(n);
    const v = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  base128() {
    let acc = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (i === 0 && b === 0x80) bad('damaged WOFF2 font: number');
      if (acc & 0xfe000000) bad('damaged WOFF2 font: number');
      acc = (acc * 128 + (b & 0x7f)) >>> 0;
      if (!(b & 0x80)) return acc;
    }
    return bad('damaged WOFF2 font: number');
  }
  u255() {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 506;
    return code;
  }
}

const withSign = (flag: number, base: number) => (flag & 1 ? base : -base);

/** Rebuilds glyf + loca from the WOFF2 transformed glyf table (WOFF2 spec, section 5). */
function rebuildGlyf(src: Buffer): { glyf: Buffer; loca: Buffer; xMins: number[]; indexFormat: number } {
  const h = new Reader(src, 'glyf');
  h.u16(); // version
  const options = h.u16();
  const numGlyphs = h.u16();
  const indexFormat = h.u16();
  const sizes = [h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32()];
  let at = h.pos;
  const take = (n: number, name: string) => {
    if (at + n > src.length) bad(`damaged WOFF2 font: ${name} stream`);
    const r = new Reader(src.subarray(at, at + n), name);
    at += n;
    return r;
  };
  const nContour = take(sizes[0], 'contour');
  const nPoints = take(sizes[1], 'points');
  const flags = take(sizes[2], 'flags');
  const glyphs = take(sizes[3], 'glyph');
  const composite = take(sizes[4], 'composite');
  const bboxAll = take(sizes[5], 'bbox');
  const instr = take(sizes[6], 'instructions');
  const bitmapLen = ((numGlyphs + 31) >> 5) << 2;
  const bboxBitmap = bboxAll.bytes(bitmapLen);
  const overlap = options & 1 ? take(bitmapLen, 'overlap').bytes(bitmapLen) : null;
  const bit = (bm: Buffer, i: number) => (bm[i >> 3] & (0x80 >> (i & 7))) !== 0;

  const parts: Buffer[] = [];
  const offsets: number[] = [0];
  const xMins: number[] = [];
  let total = 0;
  for (let g = 0; g < numGlyphs; g++) {
    const nc = nContour.i16();
    const hasBox = bit(bboxBitmap, g);
    let out: Buffer;
    if (nc === 0) {
      if (hasBox) bad('damaged WOFF2 font: empty glyph with a box');
      out = Buffer.alloc(0);
      xMins.push(0);
    } else if (nc > 0) {
      const ends: number[] = [];
      let count = 0;
      for (let c = 0; c < nc; c++) {
        count += nPoints.u255();
        ends.push(count - 1);
      }
      if (count > 0xffff) bad('damaged WOFF2 font: too many points');
      const fl = flags.bytes(count);
      const xs = new Int32Array(count);
      const ys = new Int32Array(count);
      const on: boolean[] = [];
      let x = 0;
      let y = 0;
      for (let i = 0; i < count; i++) {
        const raw = fl[i];
        on.push(!(raw & 0x80));
        const f = raw & 0x7f;
        let dx: number;
        let dy: number;
        if (f < 10) {
          dx = 0;
          dy = withSign(f, ((f & 14) << 7) + glyphs.u8());
        } else if (f < 20) {
          dx = withSign(f, (((f - 10) & 14) << 7) + glyphs.u8());
          dy = 0;
        } else if (f < 84) {
          const b0 = f - 20;
          const b1 = glyphs.u8();
          dx = withSign(f, 1 + (b0 & 0x30) + (b1 >> 4));
          dy = withSign(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
        } else if (f < 120) {
          const b0 = f - 84;
          const b1 = glyphs.u8();
          const b2 = glyphs.u8();
          dx = withSign(f, 1 + (Math.floor(b0 / 12) << 8) + b1);
          dy = withSign(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2);
        } else if (f < 124) {
          const b1 = glyphs.u8();
          const b2 = glyphs.u8();
          const b3 = glyphs.u8();
          dx = withSign(f, (b1 << 4) + (b2 >> 4));
          dy = withSign(f >> 1, ((b2 & 0x0f) << 8) + b3);
        } else {
          const b1 = glyphs.u8();
          const b2 = glyphs.u8();
          const b3 = glyphs.u8();
          const b4 = glyphs.u8();
          dx = withSign(f, (b1 << 8) + b2);
          dy = withSign(f >> 1, (b3 << 8) + b4);
        }
        x += dx;
        y += dy;
        xs[i] = x;
        ys[i] = y;
      }
      const insLen = glyphs.u255();
      const ins = instr.bytes(insLen);
      let box: number[];
      if (hasBox) box = [bboxAll.i16(), bboxAll.i16(), bboxAll.i16(), bboxAll.i16()];
      else if (count) box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      else box = [0, 0, 0, 0];
      xMins.push(box[0]);
      // plain encoding: one flag byte per point, short coordinates where they fit
      const fOut = Buffer.alloc(count);
      const xOut: number[] = [];
      const yOut: number[] = [];
      let px = 0;
      let py = 0;
      for (let i = 0; i < count; i++) {
        let f = on[i] ? 0x01 : 0;
        if (i === 0 && overlap && bit(overlap, g)) f |= 0x40;
        const ddx = xs[i] - px;
        const ddy = ys[i] - py;
        px = xs[i];
        py = ys[i];
        if (ddx === 0) f |= 0x10;
        else if (Math.abs(ddx) < 256) {
          f |= 0x02 | (ddx > 0 ? 0x10 : 0);
          xOut.push(-1, Math.abs(ddx));
        } else xOut.push(-2, ddx);
        if (ddy === 0) f |= 0x20;
        else if (Math.abs(ddy) < 256) {
          f |= 0x04 | (ddy > 0 ? 0x20 : 0);
          yOut.push(-1, Math.abs(ddy));
        } else yOut.push(-2, ddy);
        fOut[i] = f;
      }
      const coordLen = (a: number[]) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 2) n += a[i] === -1 ? 1 : 2;
        return n;
      };
      out = Buffer.alloc(10 + 2 * nc + 2 + insLen + count + coordLen(xOut) + coordLen(yOut));
      let o = 0;
      out.writeInt16BE(nc, o);
      o += 2;
      for (const v of box) {
        out.writeInt16BE(v, o);
        o += 2;
      }
      for (const e of ends) {
        out.writeUInt16BE(e, o);
        o += 2;
      }
      out.writeUInt16BE(insLen, o);
      o += 2;
      ins.copy(out, o);
      o += insLen;
      fOut.copy(out, o);
      o += count;
      for (const a of [xOut, yOut])
        for (let i = 0; i < a.length; i += 2) {
          if (a[i] === -1) out[o++] = a[i + 1];
          else {
            out.writeInt16BE(a[i + 1], o);
            o += 2;
          }
        }
    } else if (nc === -1) {
      if (!hasBox) bad('damaged WOFF2 font: composite glyph without a box');
      const start = composite.pos;
      let haveInstr = false;
      for (let more = true; more; ) {
        const f = composite.u16();
        composite.u16(); // glyph index
        composite.bytes(f & 0x0001 ? 4 : 2);
        if (f & 0x0008) composite.bytes(2);
        else if (f & 0x0040) composite.bytes(4);
        else if (f & 0x0080) composite.bytes(8);
        if (f & 0x0100) haveInstr = true;
        more = (f & 0x0020) !== 0;
      }
      const comp = composite.b.subarray(start, composite.pos);
      const box = [bboxAll.i16(), bboxAll.i16(), bboxAll.i16(), bboxAll.i16()];
      xMins.push(box[0]);
      const ins: Buffer = haveInstr ? instr.bytes(glyphs.u255()) : Buffer.alloc(0);
      out = Buffer.alloc(10 + comp.length + (haveInstr ? 2 + ins.length : 0));
      out.writeInt16BE(-1, 0);
      box.forEach((v, i) => out.writeInt16BE(v, 2 + i * 2));
      comp.copy(out, 10);
      if (haveInstr) {
        out.writeUInt16BE(ins.length, 10 + comp.length);
        ins.copy(out, 12 + comp.length);
      }
    } else out = bad('damaged WOFF2 font: contour count');
    const padded = (out.length + 3) & ~3;
    if (padded !== out.length) out = Buffer.concat([out, Buffer.alloc(padded - out.length)]);
    parts.push(out);
    total += out.length;
    if (total > MAX_FONT) bad('font too large');
    offsets.push(total);
  }
  const glyf = Buffer.concat(parts);
  const loca = Buffer.alloc(indexFormat ? offsets.length * 4 : offsets.length * 2);
  offsets.forEach((v, i) => (indexFormat ? loca.writeUInt32BE(v, i * 4) : loca.writeUInt16BE(v / 2, i * 2)));
  return { glyf, loca, xMins, indexFormat };
}

/** Rebuilds hmtx from the WOFF2 transformed hmtx table (left side bearings taken from the glyph boxes). */
function rebuildHmtx(src: Buffer, numGlyphs: number, numHMetrics: number, xMins: number[]): Buffer {
  const r = new Reader(src, 'hmtx');
  const flags = r.u8();
  const adv: number[] = [];
  for (let i = 0; i < numHMetrics; i++) adv.push(r.u16());
  const lsb: number[] = [];
  for (let i = 0; i < numHMetrics; i++) lsb.push(flags & 1 ? (xMins[i] ?? 0) : r.i16());
  for (let i = numHMetrics; i < numGlyphs; i++) lsb.push(flags & 2 ? (xMins[i] ?? 0) : r.i16());
  const out = Buffer.alloc(numHMetrics * 4 + (numGlyphs - numHMetrics) * 2);
  let o = 0;
  for (let i = 0; i < numHMetrics; i++) {
    out.writeUInt16BE(adv[i], o);
    out.writeInt16BE(lsb[i], o + 2);
    o += 4;
  }
  for (let i = numHMetrics; i < numGlyphs; i++) {
    out.writeInt16BE(lsb[i], o);
    o += 2;
  }
  return out;
}

export function woff2ToSfnt(buf: Buffer): Buffer {
  const r = new Reader(buf, 'header');
  if (r.u32() !== WOFF2) bad('not a WOFF2 font');
  const flavor = r.u32();
  if (flavor === 0x74746366) bad('font collections are not supported');
  r.u32(); // length
  const num = r.u16();
  r.u16(); // reserved
  const totalSfnt = r.u32();
  const compressed = r.u32();
  r.bytes(24); // versions, metadata and private block
  if (num < 1 || num > 200 || totalSfnt > MAX_FONT) bad('damaged WOFF2 font');
  const dir: { tag: string; orig: number; len: number; transformed: boolean }[] = [];
  for (let i = 0; i < num; i++) {
    const flags = r.u8();
    const tag = (flags & 63) === 63 ? tagOf(r.u32()) : KNOWN_TAGS[flags & 63];
    const version = flags >> 6;
    const orig = r.base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    const len = transformed ? r.base128() : orig;
    if (orig > MAX_FONT || len > MAX_FONT) bad('damaged WOFF2 font: table size');
    dir.push({ tag, orig, len, transformed });
  }
  if (r.pos + compressed > buf.length) bad('damaged WOFF2 font: data');
  const sum = dir.reduce((a, d) => a + d.len, 0);
  const data = zlib.brotliDecompressSync(buf.subarray(r.pos, r.pos + compressed), { maxOutputLength: Math.max(sum, 1) });
  if (data.length < sum) bad('damaged WOFF2 font: data size');
  const raw = new Map<string, Buffer>();
  let at = 0;
  for (const d of dir) {
    raw.set(d.tag, data.subarray(at, at + d.len));
    at += d.len;
  }
  const tables: Table[] = [];
  let rebuilt: ReturnType<typeof rebuildGlyf> | null = null;
  const glyfDir = dir.find((d) => d.tag === 'glyf');
  if (glyfDir?.transformed) rebuilt = rebuildGlyf(raw.get('glyf')!);
  for (const d of dir) {
    if (d.tag === 'glyf' && rebuilt) tables.push({ tag: 'glyf', data: rebuilt.glyf });
    else if (d.tag === 'loca' && d.transformed) {
      if (!rebuilt) bad('damaged WOFF2 font: loca without glyf');
      tables.push({ tag: 'loca', data: rebuilt!.loca });
    } else if (d.tag === 'hmtx' && d.transformed) {
      const maxp = raw.get('maxp');
      const hhea = raw.get('hhea');
      if (!rebuilt || !maxp || maxp.length < 6 || !hhea || hhea.length < 36) bad('damaged WOFF2 font: hmtx');
      tables.push({ tag: 'hmtx', data: rebuildHmtx(raw.get('hmtx')!, maxp!.readUInt16BE(4), hhea!.readUInt16BE(34), rebuilt!.xMins) });
    } else if (d.transformed) bad(`unsupported WOFF2 transform for ${d.tag}`);
    else tables.push({ tag: d.tag, data: Buffer.from(raw.get(d.tag)!) });
  }
  if (rebuilt) {
    const head = tables.find((t) => t.tag === 'head');
    if (head && head.data.length >= 52) head.data.writeInt16BE(rebuilt.indexFormat, 50);
  }
  return writeSfnt(flavor, tables);
}

// ---------- names ----------

function decodeName(platform: number, data: Buffer) {
  if (platform === 0 || platform === 3) {
    let s = '';
    for (let i = 0; i + 1 < data.length; i += 2) s += String.fromCharCode(data.readUInt16BE(i));
    return s;
  }
  return data.toString('latin1');
}

/** Family, subfamily and weight of an sfnt, from its name and OS/2 tables. */
export function sfntInfo(buf: Buffer): { family: string; style: string; weight: number; italic: boolean; format: 'ttf' | 'otf'; scale: number } {
  const { tables } = readSfnt(buf);
  const name = tables.find((t) => t.tag === 'name')?.data ?? bad('the font has no name table');
  const count = name.readUInt16BE(2);
  const strings = name.readUInt16BE(4);
  const found = new Map<number, { score: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const rec = 6 + i * 12;
    if (rec + 12 > name.length) break;
    const platform = name.readUInt16BE(rec);
    const lang = name.readUInt16BE(rec + 4);
    const id = name.readUInt16BE(rec + 6);
    const len = name.readUInt16BE(rec + 8);
    const off = name.readUInt16BE(rec + 10);
    if (![1, 2, 16, 17].includes(id) || strings + off + len > name.length) continue;
    // prefer Windows English, then any Windows / Unicode, then Mac
    const score = platform === 3 && lang === 0x409 ? 3 : platform === 3 || platform === 0 ? 2 : 1;
    const prev = found.get(id);
    if (!prev || score > prev.score) found.set(id, { score, value: decodeName(platform, name.subarray(strings + off, strings + off + len)).trim() });
  }
  const family = found.get(1)?.value || found.get(16)?.value || bad('the font has no family name');
  const style = found.get(2)?.value || 'Regular';
  const os2 = tables.find((t) => t.tag === 'OS/2')?.data;
  const weight = os2 && os2.length >= 6 ? os2.readUInt16BE(4) : /bold/i.test(style) ? 700 : 400;
  const italic = os2 && os2.length >= 64 ? (os2.readUInt16BE(62) & 1) === 1 : /italic|oblique/i.test(style);
  // libass sizes text by the font's full line height (Windows ascent + descent, else hhea), CSS by the
  // em box: the ratio between them keeps the export the size the player shows
  const head = tables.find((t) => t.tag === 'head')?.data;
  const hhea = tables.find((t) => t.tag === 'hhea')?.data;
  const upm = head && head.length >= 20 ? head.readUInt16BE(18) : 0;
  let span = os2 && os2.length >= 78 ? os2.readUInt16BE(74) + os2.readUInt16BE(76) : 0;
  if (!span && hhea && hhea.length >= 8) span = hhea.readInt16BE(4) - hhea.readInt16BE(6);
  const scale = upm > 0 && span > 0 ? Math.round((span / upm) * 1000) / 1000 : 1.15;
  return { family, style, weight: Math.max(100, Math.min(900, weight || 400)), italic, format: fontFormat(buf) === 'otf' ? 'otf' : 'ttf', scale: Math.max(0.5, Math.min(3, scale)) };
}

/** Any supported font file as an sfnt (TTF / OTF), checked by reading its names. */
export function toSfnt(buf: Buffer): Buffer {
  if (buf.length > MAX_FONT) bad('font too large (30 MB at most)');
  const fmt = fontFormat(buf);
  let out: Buffer;
  try {
    out = fmt === 'woff' ? woffToSfnt(buf) : fmt === 'woff2' ? woff2ToSfnt(buf) : fmt ? buf : bad('not a font file (TTF, OTF, WOFF or WOFF2)');
  } catch (e) {
    if (e instanceof FontError) throw e;
    throw new FontError(`damaged font file: ${(e as Error).message}`);
  }
  sfntInfo(out);
  return out;
}
