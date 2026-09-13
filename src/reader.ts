export const SegmentType = {
  PaletteDefinition: 0x14,
  ObjectDefinition: 0x15,
  PresentationComposition: 0x16,
  WindowDefinition: 0x17,
  End: 0x80,
} as const;

export type SegmentType = (typeof SegmentType)[keyof typeof SegmentType];

export const CompositionState = {
  Normal: 0x00,
  AcquisitionPoint: 0x40,
  EpochStart: 0x80,
} as const;

export type CompositionState = (typeof CompositionState)[keyof typeof CompositionState];

export interface Segment {
  pts: number;
  dts: number;
  segmentType: SegmentType;
  segmentLength: number;
  startOffset: number;
  endOffset: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PresentationComposition {
  width: number;
  height: number;
  frameRate: number;
  compositionNumber: number;
  compositionState: CompositionState;
  paletteUpdate: boolean;
  paletteId: number;
  objects: CompositionObject[];
}

export interface CompositionObject {
  objectId: number;
  windowId: number;
  x: number;
  y: number;
  forced: boolean;
  crop?: Rect;
}

export interface WindowDefinition extends Rect {
  id: number;
}

export interface PaletteDefinition {
  id: number;
  version: number;
  entries: PaletteEntry[];
}

export interface PaletteEntry {
  index: number;
  y: number;
  cr: number;
  cb: number;
  alpha: number;
}

export interface ObjectDefinition {
  id: number;
  version: number;
  firstInSequence: boolean;
  lastInSequence: boolean;
  data: Uint8Array;
}

export const PTS_PER_SECOND = 90_000;

const MAGIC_NUMBER = 0x5047;
const HEADER_LENGTH = 13;

const MINIMUM_PAYLOAD: Record<number, number> = {
  [SegmentType.PaletteDefinition]: 2,
  [SegmentType.ObjectDefinition]: 4,
  [SegmentType.PresentationComposition]: 11,
  [SegmentType.WindowDefinition]: 1,
  [SegmentType.End]: 0,
};

const COMPOSITION_OBJECT_LENGTH = 8;
const CROPPED_OBJECT_LENGTH = 16;
const WINDOW_LENGTH = 9;
const PALETTE_ENTRY_LENGTH = 5;
const OBJECT_DATA_LENGTH_FIELD = 3;

export class Reader {
  private bytes: Uint8Array;
  private view: DataView;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  isValidPGS(): boolean {
    return this.hasSegmentAt(0);
  }

  readSegments(): Segment[] {
    const segments: Segment[] = [];
    let offset = 0;

    while (this.hasSegmentAt(offset)) {
      const segment = this.readSegment(offset);
      if (segment.endOffset > this.view.byteLength || segment.segmentLength < (MINIMUM_PAYLOAD[segment.segmentType] ?? 0)) {
        break;
      }

      segments.push(segment);
      offset = segment.endOffset;
    }

    return segments;
  }

  readSegment(offset: number): Segment {
    const segmentLength = this.view.getUint16(offset + 11);

    return {
      pts: this.view.getUint32(offset + 2),
      dts: this.view.getUint32(offset + 6),
      segmentType: this.view.getUint8(offset + 10) as SegmentType,
      segmentLength,
      startOffset: offset,
      endOffset: offset + HEADER_LENGTH + segmentLength,
    };
  }

  readPresentationComposition(segment: Segment): PresentationComposition {
    const offset = segment.startOffset + HEADER_LENGTH;
    const objectCount = this.view.getUint8(offset + 10);
    const objects: CompositionObject[] = [];
    let position = offset + 11;

    for (let i = 0; i < objectCount && position + COMPOSITION_OBJECT_LENGTH <= segment.endOffset; i++) {
      const flags = this.view.getUint8(position + 3);
      const cropped = (flags & 0x80) !== 0 && position + CROPPED_OBJECT_LENGTH <= segment.endOffset;

      objects.push({
        objectId: this.view.getUint16(position),
        windowId: this.view.getUint8(position + 2),
        x: this.view.getUint16(position + 4),
        y: this.view.getUint16(position + 6),
        forced: (flags & 0x40) !== 0,
        crop: cropped ? this.readRect(position + 8) : undefined,
      });

      position += cropped ? CROPPED_OBJECT_LENGTH : COMPOSITION_OBJECT_LENGTH;
    }

    return {
      width: this.view.getUint16(offset),
      height: this.view.getUint16(offset + 2),
      frameRate: this.view.getUint8(offset + 4),
      compositionNumber: this.view.getUint16(offset + 5),
      compositionState: this.view.getUint8(offset + 7) as CompositionState,
      paletteUpdate: this.view.getUint8(offset + 8) === 0x80,
      paletteId: this.view.getUint8(offset + 9),
      objects,
    };
  }

  readWindowDefinitions(segment: Segment): WindowDefinition[] {
    const offset = segment.startOffset + HEADER_LENGTH;
    const windowCount = this.view.getUint8(offset);
    const windows: WindowDefinition[] = [];
    let position = offset + 1;

    for (let i = 0; i < windowCount && position + WINDOW_LENGTH <= segment.endOffset; i++) {
      windows.push({ id: this.view.getUint8(position), ...this.readRect(position + 1) });
      position += WINDOW_LENGTH;
    }

    return windows;
  }

  readPaletteDefinition(segment: Segment): PaletteDefinition {
    const offset = segment.startOffset + HEADER_LENGTH;
    const entries: PaletteEntry[] = [];

    for (let position = offset + 2; position + PALETTE_ENTRY_LENGTH <= segment.endOffset; position += PALETTE_ENTRY_LENGTH) {
      entries.push({
        index: this.view.getUint8(position),
        y: this.view.getUint8(position + 1),
        cr: this.view.getUint8(position + 2),
        cb: this.view.getUint8(position + 3),
        alpha: this.view.getUint8(position + 4),
      });
    }

    return { id: this.view.getUint8(offset), version: this.view.getUint8(offset + 1), entries };
  }

  readObjectDefinition(segment: Segment): ObjectDefinition {
    const offset = segment.startOffset + HEADER_LENGTH;
    const sequence = this.view.getUint8(offset + 3);
    const firstInSequence = (sequence & 0x80) !== 0;
    const dataOffset = offset + 4 + (firstInSequence ? OBJECT_DATA_LENGTH_FIELD : 0);

    return {
      id: this.view.getUint16(offset),
      version: this.view.getUint8(offset + 2),
      firstInSequence,
      lastInSequence: (sequence & 0x40) !== 0,
      data: this.bytes.subarray(Math.min(dataOffset, segment.endOffset), segment.endOffset),
    };
  }

  private hasSegmentAt(offset: number): boolean {
    return offset + HEADER_LENGTH <= this.view.byteLength && this.view.getUint16(offset) === MAGIC_NUMBER;
  }

  private readRect(offset: number): Rect {
    return {
      x: this.view.getUint16(offset),
      y: this.view.getUint16(offset + 2),
      width: this.view.getUint16(offset + 4),
      height: this.view.getUint16(offset + 6),
    };
  }
}
