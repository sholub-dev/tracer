// Carries a payload in the RGB low bits of opaque pixels: survives chunk-stripping (Slack, email), not lossy re-encoding.

const MAGIC = Uint8Array.from([0x54, 0x52, 0x43, 0x31]); // "TRC1"
const LENGTH_FIELD_BYTES = 4; // u32 big-endian
const HEADER_BYTES = MAGIC.length + LENGTH_FIELD_BYTES;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // decode-side sanity cap against malformed headers

async function loadBitmap(pngBytes: Uint8Array): Promise<ImageBitmap> {
  const blob = new Blob([pngBytes.buffer as ArrayBuffer], { type: "image/png" });
  return createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
}

function drawToCanvas(bmp: ImageBitmap): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; imageData: ImageData } {
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2D context unavailable");
  ctx.drawImage(bmp, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { canvas, ctx, imageData };
}

function writeStream(data: Uint8ClampedArray, stream: Uint8Array): void {
  const totalBits = stream.length * 8;
  let bitIdx = 0;
  for (let px = 0; px < data.length && bitIdx < totalBits; px += 4) {
    if (data[px + 3] !== 255) continue;
    for (let c = 0; c < 3 && bitIdx < totalBits; c++) {
      const byteIdx = bitIdx >> 3;
      const bitInByte = 7 - (bitIdx & 7);
      const bit = (stream[byteIdx] >> bitInByte) & 1;
      data[px + c] = (data[px + c] & 0xfe) | bit;
      bitIdx++;
    }
  }
  if (bitIdx < totalBits) throw new Error("LSB write ran out of capacity mid-stream");
}

function readStream(data: Uint8ClampedArray, byteCount: number): Uint8Array | null {
  const out = new Uint8Array(byteCount);
  const totalBits = byteCount * 8;
  let bitIdx = 0;
  for (let px = 0; px < data.length && bitIdx < totalBits; px += 4) {
    if (data[px + 3] !== 255) continue;
    for (let c = 0; c < 3 && bitIdx < totalBits; c++) {
      const byteIdx = bitIdx >> 3;
      const bitInByte = 7 - (bitIdx & 7);
      out[byteIdx] |= (data[px + c] & 1) << bitInByte;
      bitIdx++;
    }
  }
  return bitIdx >= totalBits ? out : null;
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) { reject(new Error("canvas.toBlob returned null")); return; }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

/** Encodes `payload` into the pixels of `pngBytes`; throws if the image is too small to hold it. */
export async function encodePngWithPayload(pngBytes: Uint8Array, payload: Uint8Array): Promise<Uint8Array> {
  const bmp = await loadBitmap(pngBytes);
  try {
    const { canvas, ctx, imageData } = drawToCanvas(bmp);

    const stream = new Uint8Array(HEADER_BYTES + payload.length);
    stream.set(MAGIC, 0);
    new DataView(stream.buffer).setUint32(MAGIC.length, payload.length, false);
    stream.set(payload, HEADER_BYTES);

    writeStream(imageData.data, stream);
    ctx.putImageData(imageData, 0, 0);
    return await canvasToPngBytes(canvas);
  } finally {
    bmp.close?.();
  }
}

/** The payload in `pngBytes`, or null when there is no Tracer header (unrelated or re-encoded PNG). */
export async function decodePngPayload(pngBytes: Uint8Array): Promise<Uint8Array | null> {
  const bmp = await loadBitmap(pngBytes);
  try {
    const { imageData: { data } } = drawToCanvas(bmp);

    const header = readStream(data, HEADER_BYTES);
    if (!header) return null;
    for (let i = 0; i < MAGIC.length; i++) if (header[i] !== MAGIC[i]) return null;

    const length = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(MAGIC.length, false);
    if (length <= 0 || length > MAX_PAYLOAD_BYTES) return null;

    const full = readStream(data, HEADER_BYTES + length);
    return full ? full.subarray(HEADER_BYTES) : null;
  } finally {
    bmp.close?.();
  }
}
