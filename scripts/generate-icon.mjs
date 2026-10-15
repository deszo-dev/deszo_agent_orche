import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';

// Code-native mark, shared by the Windows executable and Tauri window.
const size = 64;
const scanlines = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const corner = Math.max(12 - x, x - 51, 0) ** 2 + Math.max(12 - y, y - 51, 0) ** 2 > 144;
  const stem = x >= 17 && x <= 23 && y >= 17 && y <= 46;
  const arc = x >= 23 && x <= 43 && y >= 17 && y <= 46 &&
    ((x <= 35 && (y <= 23 || y >= 40)) || (x >= 36 && y >= 22 && y <= 41));
  const dot = (x - 49) ** 2 + (y - 47) ** 2 <= 12;
  const pixel = corner ? [0, 0, 0, 0] : dot ? [170, 243, 202, 255]
    : stem || arc ? [236, 232, 255, 255] : [91, 79, 153, 255];
  scanlines.set(pixel, y * (size * 4 + 1) + 1 + x * 4);
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([header, body, checksum]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = size; ico[7] = size;
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
const directory = resolve('src-tauri/icons');
await mkdir(directory, { recursive: true });
await writeFile(resolve(directory, 'icon.png'), png);
await writeFile(resolve(directory, 'icon.ico'), Buffer.concat([ico, png]));
