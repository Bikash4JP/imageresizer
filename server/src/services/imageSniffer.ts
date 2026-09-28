import { open } from 'node:fs/promises';

/**
 * Content-based type detection. The client-supplied filename and MIME type are
 * never trusted; the first bytes of the upload must match a known signature
 * from the allowlist before the file reaches the decoder.
 *
 * SVG, PDF, HEIC and every other format are rejected outright — SVG in
 * particular carries script and external-entity risks through librsvg.
 */
export const INPUT_FORMATS = ['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif'] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

const HEADER_BYTES = 32;

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString('latin1');

export function sniffImageType(header: Buffer): InputFormat | null {
  if (startsWith(header, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(header, 0, 6) === 'GIF87a' || ascii(header, 0, 6) === 'GIF89a') return 'gif';
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 12) === 'WEBP') return 'webp';
  if (startsWith(header, [0x49, 0x49, 0x2a, 0x00]) || startsWith(header, [0x4d, 0x4d, 0x00, 0x2a])) return 'tiff';
  // ISO-BMFF: [size:4]['ftyp'][major brand:4]. Only AVIF brands are accepted;
  // HEIC ('heic', 'heix', 'mif1' without avif) is not decodable by prebuilt libvips.
  if (ascii(header, 4, 8) === 'ftyp') {
    const brand = ascii(header, 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

export async function sniffFile(filePath: string): Promise<InputFormat | null> {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
    return sniffImageType(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
