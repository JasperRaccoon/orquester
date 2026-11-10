// A desktop capture's raw pixels and their conversion to RGB (spec 2026-11-10 §2.3). The engine
// copies GetImage's 32-bit pixels as the server sent them; the conversion runs in the image
// workers (`devices/image-worker.ts` imports this module), never on the event loop. Erasable
// TypeScript only: Node's own type stripping loads it in a worker too.

/** How a capture's pixels are laid out: 32 bits each, in the server's image byte order, its channels under the root visual's masks. */
export interface DesktopPixelFormat {
  byteOrder: "lsb" | "msb";
  redMask: number;
  greenMask: number;
  blueMask: number;
}

/** `count` 32-bit pixels in `format` → RGB, 3 bytes per pixel. */
export function pixelsToRgb(pixels: Uint8Array, format: DesktopPixelFormat, count: number): Buffer {
  if (pixels.length < count * 4) throw new RangeError(`${pixels.length} bytes hold fewer than ${count} 32-bit pixels`);
  const rgb = Buffer.allocUnsafe(count * 3);
  const lsb = format.byteOrder === "lsb";
  const { redMask, greenMask, blueMask } = format;
  if (redMask === 0xff0000 && greenMask === 0xff00 && blueMask === 0xff) {
    // The usual layout: B G R X in memory (LSBFirst), X R G B (MSBFirst).
    const [r, g, b] = lsb ? [2, 1, 0] : [1, 2, 3];
    for (let i = 0, s = 0, d = 0; i < count; i++, s += 4, d += 3) {
      rgb[d] = pixels[s + r!]!;
      rgb[d + 1] = pixels[s + g!]!;
      rgb[d + 2] = pixels[s + b!]!;
    }
    return rgb;
  }
  const channel = (mask: number): { mask: number; shift: number; scale: Uint8Array } => {
    let shift = 0;
    while (shift < 32 && ((mask >>> shift) & 1) === 0) shift++;
    const max = mask >>> shift;
    const scale = new Uint8Array(max + 1);
    for (let v = 0; v <= max; v++) scale[v] = Math.round((v * 255) / max);
    return { mask, shift, scale };
  };
  const red = channel(redMask);
  const green = channel(greenMask);
  const blue = channel(blueMask);
  const view = new DataView(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  for (let i = 0, s = 0, d = 0; i < count; i++, s += 4, d += 3) {
    const pixel = view.getUint32(s, lsb);
    rgb[d] = red.scale[(pixel & red.mask) >>> red.shift]!;
    rgb[d + 1] = green.scale[(pixel & green.mask) >>> green.shift]!;
    rgb[d + 2] = blue.scale[(pixel & blue.mask) >>> blue.shift]!;
  }
  return rgb;
}
