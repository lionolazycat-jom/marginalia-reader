// Minimal ZIP reader (EPUB, CBZ) built on the browser's native DecompressionStream.
// Reads the central directory, so entries are found without scanning the whole archive.

export class Zip {
  static async open(blob) {
    const z = new Zip();
    z.blob = blob;
    const tailLen = Math.min(blob.size, 65557);
    const tail = new DataView(await blob.slice(blob.size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError('This file is not a valid ZIP/EPUB archive (it may be damaged or incomplete).');
    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);
    if (cdOffset === 0xffffffff || count === 0xffff) {
      // ZIP64 end of central directory locator sits 20 bytes before EOCD
      const loc = eocd - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
        const z64off = Number(tail.getBigUint64(loc + 8, true));
        const z64 = new DataView(await blob.slice(z64off, z64off + 56).arrayBuffer());
        count = Number(z64.getBigUint64(32, true));
        cdSize = Number(z64.getBigUint64(40, true));
        cdOffset = Number(z64.getBigUint64(48, true));
      }
    }
    const cd = new DataView(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dec = new TextDecoder('utf-8');
    z.entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
      if (cd.getUint32(p, true) !== 0x02014b50) break;
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let csize = cd.getUint32(p + 20, true);
      let usize = cd.getUint32(p + 24, true);
      const nlen = cd.getUint16(p + 28, true);
      const xlen = cd.getUint16(p + 30, true);
      const clen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nlen));
      // ZIP64 extra field
      let xp = p + 46 + nlen;
      const xend = xp + xlen;
      while (xp + 4 <= xend) {
        const id = cd.getUint16(xp, true), sz = cd.getUint16(xp + 2, true);
        if (id === 1) {
          let q = xp + 4;
          if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (offset === 0xffffffff) { offset = Number(cd.getBigUint64(q, true)); }
        }
        xp += 4 + sz;
      }
      if (!name.endsWith('/')) z.entries.set(name, { name, method, csize, usize, offset, encrypted: !!(flags & 1) });
      p += 46 + nlen + xlen + clen;
    }
    z.lower = new Map([...z.entries.keys()].map((k) => [k.toLowerCase(), k]));
    return z;
  }

  has(path) { return this.entries.has(path) || this.lower.has(path.toLowerCase()); }
  entry(path) { return this.entries.get(path) || this.entries.get(this.lower.get(path.toLowerCase())); }
  names() { return [...this.entries.keys()]; }

  async bytes(path) {
    const e = this.entry(path);
    if (!e) throw new ZipError(`Missing file inside archive: ${path}`);
    if (e.encrypted) throw new ZipError('This archive is encrypted or DRM-protected and cannot be opened.');
    const head = new DataView(await this.blob.slice(e.offset, e.offset + 30).arrayBuffer());
    if (head.getUint32(0, true) !== 0x04034b50) throw new ZipError('The archive is corrupted (bad local header).');
    const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const raw = this.blob.slice(start, start + e.csize);
    if (e.method === 0) return new Uint8Array(await raw.arrayBuffer());
    if (e.method !== 8) throw new ZipError(`Unsupported compression method (${e.method}).`);
    if (typeof DecompressionStream === 'undefined') throw new ZipError('This browser cannot decompress EPUB files. Update your browser and try again.');
    const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async text(path) {
    const b = await this.bytes(path);
    return decodeText(b);
  }
  async blobOf(path, type) {
    return new Blob([await this.bytes(path)], { type: type || mimeFor(path) });
  }
}

export class ZipError extends Error {}

export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

export function mimeFor(path) {
  const ext = path.split('.').pop().toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp' })[ext] || 'application/octet-stream';
}

/** Resolve a relative href against a base file path inside the archive. */
export function resolvePath(base, href) {
  if (!href) return '';
  href = href.split('#')[0];
  try { href = decodeURIComponent(href); } catch {}
  if (href.startsWith('/')) return href.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg !== '') parts.push(seg);
  }
  return parts.join('/');
}
