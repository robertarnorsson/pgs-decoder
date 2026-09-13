import {
  CompositionState,
  SegmentType,
  type CompositionObject,
  type PaletteEntry,
  type PresentationComposition,
  type Reader,
  type Segment,
} from "./reader.ts";

export interface ObjectData {
  width: number;
  height: number;
  rle: Uint8Array;
}

export type DisplayObject = CompositionObject & ObjectData;

export interface DisplaySet {
  pts: number;
  composition: PresentationComposition;
  segments: Segment[];
  palette: PaletteEntry[];
  objects: DisplayObject[];
}

const OBJECT_HEADER_LENGTH = 4;
const MAX_COMPOSITION_SIZE = 4096;
const MAX_COMPOSITION_OBJECTS = 2;

export class DisplaySetDecoder {
  private reader: Reader;
  private palettes = new Map<number, Map<number, PaletteEntry>>();
  private objects = new Map<number, ObjectData>();
  private fragments: Uint8Array[] = [];
  private segments: Segment[] = [];
  private composition?: PresentationComposition;
  private pts = 0;

  constructor(reader: Reader) {
    this.reader = reader;
  }

  decode(segments: Segment[]): DisplaySet[] {
    const displaySets: DisplaySet[] = [];

    for (const segment of segments) {
      switch (segment.segmentType) {
        case SegmentType.PresentationComposition:
          this.startComposition(segment);
          break;

        case SegmentType.PaletteDefinition:
          this.updatePalette(segment);
          break;

        case SegmentType.ObjectDefinition:
          this.updateObject(segment);
          break;
      }

      this.segments.push(segment);

      if (segment.segmentType === SegmentType.End) {
        const displaySet = this.complete();
        if (displaySet) {
          displaySets.push(displaySet);
        }
      }
    }

    return displaySets;
  }

  private startComposition(segment: Segment) {
    this.composition = this.reader.readPresentationComposition(segment);
    this.segments = [];
    this.pts = segment.pts;

    if (this.composition.compositionState === CompositionState.EpochStart) {
      this.palettes.clear();
      this.objects.clear();
    }
  }

  private updatePalette(segment: Segment) {
    const { id, entries } = this.reader.readPaletteDefinition(segment);
    const palette = new Map(this.palettes.get(id));

    for (const entry of entries) {
      palette.set(entry.index, entry);
    }

    this.palettes.set(id, palette);
  }

  private updateObject(segment: Segment) {
    const { id, firstInSequence, lastInSequence, data } = this.reader.readObjectDefinition(segment);

    if (firstInSequence) {
      this.fragments = [];
    } else if (this.fragments.length === 0) {
      return;
    }

    this.fragments.push(data);

    if (lastInSequence) {
      const object = toObjectData(this.fragments.length === 1 ? data : concat(this.fragments));
      if (object) {
        this.objects.set(id, object);
      }
      this.fragments = [];
    }
  }

  private complete(): DisplaySet | undefined {
    const { composition, segments } = this;
    this.composition = undefined;
    this.segments = [];

    if (!composition || composition.width > MAX_COMPOSITION_SIZE || composition.height > MAX_COMPOSITION_SIZE) {
      return undefined;
    }

    return {
      pts: this.pts,
      composition,
      segments,
      palette: [...(this.palettes.get(composition.paletteId)?.values() ?? [])],
      objects: composition.objects.slice(0, MAX_COMPOSITION_OBJECTS).flatMap((placement) => {
        const object = this.objects.get(placement.objectId);
        return object ? [{ ...placement, ...object }] : [];
      }),
    };
  }
}

function toObjectData(data: Uint8Array): ObjectData | undefined {
  if (data.length < OBJECT_HEADER_LENGTH) {
    return undefined;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: view.getUint16(0),
    height: view.getUint16(2),
    rle: data.subarray(OBJECT_HEADER_LENGTH),
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}
