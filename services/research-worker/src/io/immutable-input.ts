import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface ImmutableInput {
  path: string;
  bytes: Buffer;
  text: string;
  sha256: string;
  byteLength: number;
}

/**
 * Captures an input once. Consumers must parse `text`/`bytes` from this object
 * and use its digest, so validation and audit metadata refer to identical
 * bytes even if the source path changes later.
 */
export async function captureImmutableInput(
  path: string,
): Promise<ImmutableInput> {
  const bytes = await readFile(path);
  return {
    path,
    bytes,
    text: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

export function parseCapturedJson(input: ImmutableInput): unknown {
  try {
    return JSON.parse(input.text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${input.path}: ${error.message}`);
    }
    throw error;
  }
}
