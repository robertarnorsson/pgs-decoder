import { readFile } from "node:fs/promises";

const MAGIC_NUMBER = 0x5047

export async function getBytes(path: string): Promise<Buffer> {
  const data = await readFile(path);
  return data;
}

export function isValidPGS(bytes: Buffer): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint16(0, false);
  return magic === MAGIC_NUMBER;
}

async function main() {
  const path = process.argv[2];

  if (!path) {
    process.exit(1);
  }

  const bytes = await getBytes(path);
  console.log(bytes.byteLength);

  const valid = isValidPGS(bytes)
  console.log(valid)
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});