import { readFile } from "node:fs/promises";

export interface Segment {
  pts: number;
  dts: number;
  segmentType: SegmentType;
  segmentLength: number;
  startOffset?: number;
  endOffset?: number;
}

export type SegmentType = 0x14 | 0x15 | 0x16 | 0x17 | 0x80;

const MAGIC_NUMBER = 0x5047

export async function getBytes(path: string): Promise<Buffer> {
  const data = await readFile(path);
  return data;
}

export class Reader {
  private view: DataView;

  constructor(bytes: Buffer) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  isValidPGS(): boolean {
    const magic = this.view.getUint16(0, false);
    return magic === MAGIC_NUMBER;
  }

  readSegment(index: number): Segment {
    const pts = this.view.getUint32(index + 2, false);
    const dts = this.view.getUint32(index + 6, false);
    const segmentType = this.view.getUint8(index + 10) as SegmentType;
    const segmentLength = this.view.getUint16(index + 11, false);
    return { pts, dts, segmentType, segmentLength, startOffset: index, endOffset: index + 13 + segmentLength };
  }
}

export function readAllSegments(reader: Reader, totalLength: number): Segment[] {
  const segments: Segment[] = [];
  let offset = 0;

  while (offset < totalLength) {
    const segment = reader.readSegment(offset);
    segments.push(segment);
    offset = segment.endOffset!;
  }

  return segments;
}


async function main() {
  const path = process.argv[2];

  if (!path) {
    process.exit(1);
  }

  const bytes = await getBytes(path)
  const reader = new Reader(bytes);
  const totalLength = bytes.byteLength
  console.log(totalLength)

  reader.isValidPGS() ? console.log("Valid PGS file") : console.log("Invalid PGS file");

  const segments = readAllSegments(reader, totalLength)

  console.log(segments.length)

  const lastSegment = segments.at(-1)

  console.log(lastSegment?.endOffset)
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});