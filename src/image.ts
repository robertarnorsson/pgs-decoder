import type { DisplayObject, DisplaySet } from "./decoder.ts";
import type { Rect } from "./reader.ts";

export interface SubtitleImage extends Rect {
  pixels: Uint8ClampedArray<ArrayBuffer>;
}

export type ColorSpace = "auto" | "bt601" | "bt709";

interface ColorMatrix {
  rCr: number;
  gCb: number;
  gCr: number;
  bCb: number;
}

const BT601: ColorMatrix = { rCr: 1.596, gCb: 0.392, gCr: 0.813, bCb: 2.017 };
const BT709: ColorMatrix = { rCr: 1.793, gCb: 0.213, gCr: 0.533, bCb: 2.112 };
const SD_MAX_HEIGHT = 576;
const MAX_RUN_CODE_BYTES = 3;

export class ImageDecoder {
  private displaySet: DisplaySet;
  private colors = new Uint32Array(256);

  constructor(displaySet: DisplaySet, colorSpace: ColorSpace = "auto") {
    this.displaySet = displaySet;
    this.fillColors(colorSpace);
  }

  decode(): SubtitleImage[] {
    const images: SubtitleImage[] = [];

    for (const object of this.displaySet.objects) {
      const area = object.crop ?? { x: 0, y: 0, width: object.width, height: object.height };
      if (this.isDrawable(object, area)) {
        images.push(this.decodeObject(object, area));
      }
    }

    return images;
  }

  private fillColors(colorSpace: ColorSpace) {
    const { composition, palette } = this.displaySet;
    const matrix = colorSpace === "bt709" || (colorSpace === "auto" && composition.height > SD_MAX_HEIGHT) ? BT709 : BT601;
    const channels = new Uint8ClampedArray(this.colors.buffer);

    for (const { index, y, cr, cb, alpha } of palette) {
      if (alpha === 0) {
        continue;
      }

      const luma = 1.164 * (y - 16);
      const offset = index * 4;

      channels[offset] = luma + matrix.rCr * (cr - 128);
      channels[offset + 1] = luma - matrix.gCb * (cb - 128) - matrix.gCr * (cr - 128);
      channels[offset + 2] = luma + matrix.bCb * (cb - 128);
      channels[offset + 3] = alpha;
    }
  }

  private isDrawable(object: DisplayObject, area: Rect): boolean {
    const { composition } = this.displaySet;

    return (
      area.width > 0 &&
      area.height > 0 &&
      area.x + area.width <= object.width &&
      area.y + area.height <= object.height &&
      object.width <= composition.width &&
      object.height <= composition.height
    );
  }

  private decodeObject(object: DisplayObject, area: Rect): SubtitleImage {
    const decoded = this.decodeRle(object);
    const whole = area.width === object.width && area.height === object.height;
    const pixels = whole ? decoded : crop(decoded, object.width, area);

    return {
      x: object.x,
      y: object.y,
      width: area.width,
      height: area.height,
      pixels: new Uint8ClampedArray(pixels.buffer),
    };
  }

  private decodeRle({ rle, width, height }: DisplayObject): Uint32Array<ArrayBuffer> {
    const { colors } = this;
    const pixels = new Uint32Array(width * height);
    let offset = 0;
    let position = 0;
    let lineEnd = width;

    while (offset < rle.length && lineEnd <= pixels.length) {
      const index = rle[offset++]!;
      if (index !== 0) {
        if (position < lineEnd) {
          pixels[position++] = colors[index]!;
        }
        continue;
      }

      if (offset + MAX_RUN_CODE_BYTES > rle.length) {
        break;
      }

      const flags = rle[offset++]!;
      if (flags === 0) {
        position = lineEnd;
        lineEnd += width;
        continue;
      }

      const length = flags & 0x40 ? ((flags & 0x3f) << 8) | rle[offset++]! : flags & 0x3f;
      const color = colors[flags & 0x80 ? rle[offset++]! : 0]!;
      const end = Math.min(position + length, lineEnd);

      if (color === 0) {
        position = end;
      }

      while (position < end) {
        pixels[position++] = color;
      }
    }

    return pixels;
  }
}

function crop(pixels: Uint32Array, width: number, area: Rect): Uint32Array<ArrayBuffer> {
  const cropped = new Uint32Array(area.width * area.height);

  for (let row = 0; row < area.height; row++) {
    const start = (area.y + row) * width + area.x;
    cropped.set(pixels.subarray(start, start + area.width), row * area.width);
  }

  return cropped;
}
