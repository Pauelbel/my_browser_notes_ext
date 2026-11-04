// A minimal PNG reader for screenshots (8-bit RGB/RGBA, not interlaced): enough to check pixel colours in e2e.
import {inflateSync} from 'node:zlib';

export function decodePng(buffer) {
  let offset = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * bpp);
  const stride = width * bpp;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      pixels[y * stride + x] = (v + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
  }
  return {width, height, pixel: (x, y) => { const i = (y * width + x) * bpp; return [pixels[i], pixels[i + 1], pixels[i + 2]]; }};
}

/** Share of pixels in a rectangle that look like the yellow highlight (bright red and green, low blue). */
export function yellowShare(png, rect) {
  let yellow = 0, total = 0;
  for (let y = Math.max(0, Math.floor(rect.y)); y < Math.min(png.height, rect.y + rect.height); y++) {
    for (let x = Math.max(0, Math.floor(rect.x)); x < Math.min(png.width, rect.x + rect.width); x++) {
      const [r, g, b] = png.pixel(x, y);
      total++;
      if (r > 200 && g > 200 && b < 150) yellow++;
    }
  }
  return total ? yellow / total : 0;
}
