/**
 * Works out the real type of an uploaded image from its first bytes.
 * The filename and the Content-Type header come from the client, so they prove nothing.
 */
export type ImageType = 'jpeg' | 'png' | 'webp';

export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Pixel size read from the file's own header, without decoding it. Null if the header is unreadable. */
export function readDimensions(buf: Buffer): { width: number; height: number } | null {
  if (detectImageType(buf) === 'png') {
    return buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null;
  }
  if (detectImageType(buf) === 'jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1] as number;
      if (marker === 0xff) { i += 1; continue; }
      // Start-of-frame markers carry the size. C4, C8 and CC share the range but are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Shrinks a size to fit within a square of `max` pixels, keeping its proportions. Never enlarges. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const IMAGE_FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,76}\.(png|jpe?g)$/;

/**
 * The one spelling of an image's file name used everywhere: no folders, lower case, spaces become dashes.
 * Null when it is not a plain name ending in .png, .jpg or .jpeg, so an upload and a spreadsheet cell can be matched exactly.
 */
export function normalizeImageFileName(raw: string): string | null {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? '';
  const name = base.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '-');
  return IMAGE_FILE_NAME.test(name) ? name : null;
}
