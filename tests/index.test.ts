import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, it } from "node:test";
import { DisplaySetDecoder, ImageDecoder, PTS_PER_SECOND, Reader, SegmentType, type DisplaySet, type SubtitleImage } from "../src/index.ts";

const MAX_COMPOSITION_SIZE = 4096;
const MAX_COMPOSITION_OBJECTS = 2;

const TIMING_CUES: [number, number][] = [
  [0, 2],
  [2, 4],
  [4, 4.5],
  [4.6, 7],
  [9, 29],
  [29, 30],
  [60, 63],
  [3599, 3602],
  [5400, 5403],
  [36000, 36004],
];

const fixtures = new URL("fixtures/", import.meta.url);
const malformed = new URL("malformed/", fixtures);

const validFiles = [
  ...readdirSync(fixtures)
    .filter((file) => file.endsWith(".sup"))
    .map((file) => new URL(file, fixtures)),
  new URL("../demo/sample.sup", import.meta.url),
];

const malformedFiles = readdirSync(malformed).map((file) => new URL(file, malformed));

describe("valid files", () => {
  for (const file of validFiles) {
    it(`${name(file)} is read to the last byte`, () => {
      const bytes = readFileSync(file);
      assert.equal(new Reader(bytes).readSegments().at(-1)?.endOffset, bytes.length);
    });

    it(`${name(file)} draws every object`, () => {
      for (const displaySet of decode(file)) {
        const images = draw(displaySet);
        assert.equal(images.length, displaySet.objects.length);
        assert.ok(images.every(isVisible), `invisible subtitle at ${displaySet.pts / PTS_PER_SECOND}s`);
      }
    });
  }

  it("converts palette colors with BT.709", () => {
    const [text] = draw(decode("basic.sup")[0]);
    const [narrator] = draw(decode("styled.sup")[12]);

    assert.ok(text && narrator);
    assert.ok(hasColor(text, [235, 235, 235, 255]));
    assert.ok(hasColor(text, [30, 30, 30, 255]));
    assert.ok(hasColor(narrator, [234, 214, 16, 255]));
  });

  it("converts palette colors with a requested color space", () => {
    const narrator = decode("styled.sup")[12];
    const [image] = narrator ? new ImageDecoder(narrator, "bt601").decode() : [];

    assert.ok(image && hasColor(image, [231, 225, 24, 255]));
  });

  it("reads the forced flag", () => {
    assert.deepEqual(
      decode("two-objects.sup").map(({ objects }) => objects.map(({ forced }) => forced)),
      [[true, false], [true], []],
    );
  });

  it("places subtitles at the top and bottom", () => {
    const displaySets = decode("styled.sup");
    const [sign] = draw(displaySets[8]);
    const [dialogue] = draw(displaySets[10]);

    assert.ok(sign && dialogue);
    assert.ok(sign.y < 540 && dialogue.y > 540);
  });

  it("shows every cue from start to end", () => {
    const displaySets = decode("timing.sup");
    const visibleAt = (time: number) => (displaySetAt(displaySets, time)?.objects.length ?? 0) > 0;

    TIMING_CUES.forEach(([start, end], index) => {
      assert.ok(visibleAt(start), `hidden at ${start}s`);
      assert.ok(visibleAt(end - 0.01), `hidden before ${end}s`);
      assert.equal(visibleAt(end), TIMING_CUES[index + 1]?.[0] === end, `wrong state at ${end}s`);
    });
  });

  it("draws two objects and keeps one when the other is removed", () => {
    const [both = [], sign, clear] = decode("two-objects.sup").map(draw);
    const [top, bottom] = both;

    assert.ok(top && bottom && top.y < bottom.y);
    assert.deepEqual(sign, [top]);
    assert.deepEqual(clear, []);
  });

  it("crops an object without receiving it again", () => {
    const displaySets = decode("crop.sup");
    const images = displaySets.map((displaySet) => draw(displaySet)[0]);
    const full = images[3];

    assert.deepEqual(
      images.map((image) => image?.width),
      [195, 390, 585, 780, undefined],
    );
    assert.ok(displaySets.slice(1).every((displaySet) => !hasSegment(displaySet, SegmentType.ObjectDefinition)));

    for (const image of images) {
      assert.ok(full);
      if (image) {
        assert.deepEqual(image.pixels, leftColumns(full, image.width));
      }
    }
  });

  it("fades with palette updates", () => {
    const displaySets = decode("fade.sup");

    assert.deepEqual(
      displaySets.map((displaySet) => maxAlpha(draw(displaySet))),
      [64, 128, 191, 255, 128, 64, 0],
    );
    assert.ok(displaySets.slice(1, -1).every(({ composition }) => composition.paletteUpdate));
  });

  it("joins an object split across segments", () => {
    const [displaySet] = decode("fragmented.sup");
    assert.ok(displaySet);

    const [image] = draw(displaySet);
    const fragments = displaySet.segments.filter(({ segmentType }) => segmentType === SegmentType.ObjectDefinition);

    assert.equal(fragments.length, 3);
    assert.ok(image && isVisible(image));
    assert.deepEqual([image.width, image.height], [1143, 241]);
  });
});

describe("malformed files", () => {
  const reference = draw(decode("basic.sup")[0]);

  for (const file of malformedFiles) {
    it(`${name(file)} stays within limits`, () => {
      const bytes = readFileSync(file);
      assert.ok((new Reader(bytes).readSegments().at(-1)?.endOffset ?? 0) <= bytes.length);

      for (const displaySet of decode(file)) {
        const { composition, objects } = displaySet;

        assert.ok(composition.width <= MAX_COMPOSITION_SIZE && composition.height <= MAX_COMPOSITION_SIZE);
        assert.ok(objects.length <= MAX_COMPOSITION_OBJECTS);

        for (const image of draw(displaySet)) {
          assert.ok(image.width > 0 && image.height > 0);
          assert.ok(image.width <= composition.width && image.height <= composition.height);
          assert.equal(image.pixels.length, image.width * image.height * 4);
        }
      }
    });
  }

  it("skips a composition larger than the limit", () => {
    assert.deepEqual(drawAll("malformed/huge-composition.sup"), []);
  });

  it("skips an object larger than its composition", () => {
    assert.deepEqual(drawAll("malformed/huge-object.sup"), []);
  });

  it("skips an object without a size", () => {
    assert.deepEqual(drawAll("malformed/empty-object.sup"), []);
  });

  it("skips a crop larger than its object", () => {
    assert.deepEqual(drawAll("malformed/oversized-crop.sup"), []);
  });

  it("limits a composition to two objects", () => {
    assert.equal(decode("malformed/many-placements.sup")[0]?.objects.length, MAX_COMPOSITION_OBJECTS);
  });

  it("draws nothing visible without a palette", () => {
    const images = drawAll("malformed/missing-palette.sup");
    assert.equal(images.length, 1);
    assert.ok(!images.some(isVisible));
  });

  it("ignores a placement of an unknown object", () => {
    assert.deepEqual(decode("malformed/missing-object.sup")[0]?.objects, []);
  });

  it("keeps a flooded palette to one entry per index", () => {
    const [displaySet] = decode("malformed/palette-flood.sup");
    assert.ok(displaySet && displaySet.palette.length <= 256);
    assert.deepEqual(draw(displaySet), reference);
  });

  it("ignores object fragments without a start", () => {
    assert.deepEqual(drawAll("malformed/orphan-fragments.sup"), reference);
  });

  it("ignores unknown segments", () => {
    assert.deepEqual(drawAll("malformed/unknown-segments.sup"), reference);
  });

  it("leaves rows empty when the image data runs out", () => {
    const [image] = drawAll("malformed/truncated-rle.sup");
    const [expected] = reference;

    assert.ok(image && expected && isVisible(image));
    assert.deepEqual([image.width, image.height], [expected.width, expected.height]);
    assert.ok(image.pixels.subarray(-image.width * 4).every((value) => value === 0));
  });

  it("keeps the object size when lines run too long", () => {
    const [image] = drawAll("malformed/overlong-lines.sup");
    const [expected] = reference;

    assert.ok(image && expected);
    assert.deepEqual([image.width, image.height], [expected.width, expected.height]);
  });

  it("keeps display sets in stream order", () => {
    const displaySets = decode("malformed/out-of-order.sup");

    assert.deepEqual(
      displaySets.map(({ pts }) => pts / PTS_PER_SECOND),
      [3.4, 1.2],
    );
    assert.deepEqual(draw(displaySets[1]), reference);
  });

  it("drops a display set without an end segment", () => {
    const displaySets = decode("malformed/missing-end.sup");
    assert.deepEqual(
      displaySets.map(({ objects }) => objects.length),
      [0],
    );
  });

  it("stops reading at a truncated segment", () => {
    assert.deepEqual(decode("malformed/truncated-file.sup"), []);
  });
});

function decode(file: string | URL): DisplaySet[] {
  const reader = new Reader(readFileSync(new URL(file, fixtures)));
  return new DisplaySetDecoder(reader).decode(reader.readSegments());
}

function draw(displaySet: DisplaySet | undefined): SubtitleImage[] {
  return displaySet ? new ImageDecoder(displaySet).decode() : [];
}

function drawAll(file: string): SubtitleImage[] {
  return decode(file).flatMap(draw);
}

function displaySetAt(displaySets: DisplaySet[], time: number): DisplaySet | undefined {
  const pts = Math.round(time * PTS_PER_SECOND);
  return displaySets.findLast((displaySet) => displaySet.pts <= pts);
}

function hasSegment({ segments }: DisplaySet, type: SegmentType): boolean {
  return segments.some(({ segmentType }) => segmentType === type);
}

function somePixel(image: SubtitleImage, match: (r: number, g: number, b: number, a: number) => boolean): boolean {
  const { pixels } = image;

  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (match(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!)) {
      return true;
    }
  }

  return false;
}

function hasColor(image: SubtitleImage, [red, green, blue, alpha]: number[]): boolean {
  return somePixel(image, (r, g, b, a) => r === red && g === green && b === blue && a === alpha);
}

function isVisible(image: SubtitleImage): boolean {
  return somePixel(image, (_r, _g, _b, a) => a > 0);
}

function maxAlpha(images: SubtitleImage[]): number {
  let max = 0;

  for (const image of images) {
    somePixel(image, (_r, _g, _b, a) => {
      max = Math.max(max, a);
      return false;
    });
  }

  return max;
}

function leftColumns(image: SubtitleImage, width: number): Uint8ClampedArray {
  const columns = new Uint8ClampedArray(width * image.height * 4);

  for (let row = 0; row < image.height; row++) {
    const start = row * image.width * 4;
    columns.set(image.pixels.subarray(start, start + width * 4), row * width * 4);
  }

  return columns;
}

function name(file: URL): string {
  return basename(file.pathname);
}
