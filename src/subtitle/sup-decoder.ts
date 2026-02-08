export type SupBitmapCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SupBitmap = {
  source: CanvasImageSource;
  width: number;
  height: number;
  x: number;
  y: number;
  crop?: SupBitmapCrop;
};

export type SupCue = {
  startUs: number;
  endUs: number;
  screenW: number;
  screenH: number;
  bitmaps: SupBitmap[];
};

type PgsPacket = {
  pts90k: number;
  dts90k: number;
  segmentType: number;
  payload: Uint8Array;
};

type PcsObjectRef = {
  objectId: number;
  x: number;
  y: number;
  crop?: SupBitmapCrop;
};

type PcsInfo = {
  screenW: number;
  screenH: number;
  paletteId: number;
  objects: PcsObjectRef[];
};

type DecodedObject = {
  width: number;
  height: number;
  indices: Uint8Array;
};

type ObjectAssembly = {
  width: number;
  height: number;
  expectedBytes: number | null;
  chunks: Uint8Array[];
};

type ShowEvent = {
  kind: 'show';
  startUs: number;
  screenW: number;
  screenH: number;
  palette: Uint8ClampedArray;
  objects: Array<{
    object: DecodedObject;
    x: number;
    y: number;
    crop?: SupBitmapCrop;
  }>;
};

type ClearEvent = {
  kind: 'clear';
  startUs: number;
  screenW: number;
  screenH: number;
};

type Event = ShowEvent | ClearEvent;

function readU16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU24BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function pts90kToUs(pts90k: number): number {
  if (!Number.isFinite(pts90k)) return 0;
  return Math.round((pts90k * 1_000_000) / 90_000);
}

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 255) return 255;
  return Math.round(v);
}

function ycbcrToRgb(y: number, cr: number, cb: number): { r: number; g: number; b: number } {
  const Y = y;
  const Cr = cr - 128;
  const Cb = cb - 128;
  const r = Y + 1.402 * Cr;
  const g = Y - 0.344136 * Cb - 0.714136 * Cr;
  const b = Y + 1.772 * Cb;
  return { r: clampByte(r), g: clampByte(g), b: clampByte(b) };
}

function decodeObjectRle(rle: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  if (width <= 0 || height <= 0) return out;

  let x = 0;
  let y = 0;
  let i = 0;

  while (i < rle.length && y < height) {
    const b = rle[i++];
    if (b !== 0) {
      out[y * width + x] = b;
      x += 1;
      if (x >= width) {
        x = 0;
        y += 1;
      }
      continue;
    }

    if (i >= rle.length) break;
    const b2 = rle[i++];
    if (b2 === 0) {
      x = 0;
      y += 1;
      continue;
    }

    const flag = b2 & 0xc0;
    let runLength = 0;
    let color = 0;

    if (flag === 0x00) {
      runLength = b2 & 0x3f;
      color = 0;
    } else if (flag === 0x40) {
      if (i >= rle.length) break;
      const b3 = rle[i++];
      runLength = ((b2 & 0x3f) << 8) | b3;
      color = 0;
    } else if (flag === 0x80) {
      if (i >= rle.length) break;
      const b3 = rle[i++];
      runLength = b2 & 0x3f;
      color = b3;
    } else {
      if (i + 1 >= rle.length) break;
      const b3 = rle[i++];
      const b4 = rle[i++];
      runLength = ((b2 & 0x3f) << 8) | b3;
      color = b4;
    }

    if (runLength <= 0) continue;

    while (runLength > 0 && y < height) {
      const remaining = width - x;
      const n = Math.min(runLength, remaining);
      if (n > 0) {
        out.fill(color, y * width + x, y * width + x + n);
        x += n;
        runLength -= n;
      }
      if (x >= width) {
        x = 0;
        y += 1;
      }
    }
  }

  return out;
}

function parsePCS(payload: Uint8Array): PcsInfo | null {
  if (payload.length < 11) return null;
  const screenW = readU16BE(payload, 0);
  const screenH = readU16BE(payload, 2);
  const paletteId = payload[9] ?? 0;
  const objectCount = payload[10] ?? 0;

  let offset = 11;
  const objects: PcsObjectRef[] = [];
  for (let i = 0; i < objectCount; i++) {
    if (offset + 8 > payload.length) break;
    const objectId = readU16BE(payload, offset);
    const croppedFlag = payload[offset + 3] ?? 0;
    const x = readU16BE(payload, offset + 4);
    const y = readU16BE(payload, offset + 6);
    offset += 8;

    let crop: SupBitmapCrop | undefined;
    if (croppedFlag) {
      if (offset + 8 > payload.length) break;
      const cropX = readU16BE(payload, offset);
      const cropY = readU16BE(payload, offset + 2);
      const cropW = readU16BE(payload, offset + 4);
      const cropH = readU16BE(payload, offset + 6);
      offset += 8;
      if (cropW > 0 && cropH > 0) crop = { x: cropX, y: cropY, width: cropW, height: cropH };
    }

    objects.push({ objectId, x, y, crop });
  }

  return { screenW, screenH, paletteId, objects };
}

function parseSupPackets(data: Uint8Array): PgsPacket[] {
  if (!data || data.length < 13) throw new Error('Invalid SUP/PGS: file too small');

  let offset = 0;
  if (data[0] !== 0x50 || data[1] !== 0x47) {
    let found = -1;
    for (let i = 0; i + 1 < data.length; i++) {
      if (data[i] === 0x50 && data[i + 1] === 0x47) {
        found = i;
        break;
      }
    }
    if (found === -1) throw new Error('Invalid SUP/PGS: missing PG header');
    offset = found;
  }

  const packets: PgsPacket[] = [];
  while (offset + 13 <= data.length) {
    if (data[offset] !== 0x50 || data[offset + 1] !== 0x47) {
      throw new Error(`Invalid SUP/PGS: missing PG header at offset ${offset}`);
    }

    const pts90k = readU32BE(data, offset + 2);
    const dts90k = readU32BE(data, offset + 6);
    const segmentType = data[offset + 10] ?? 0;
    const segmentLen = readU16BE(data, offset + 11);
    const payloadStart = offset + 13;
    const payloadEnd = payloadStart + segmentLen;
    if (payloadEnd > data.length) break;

    packets.push({
      pts90k,
      dts90k,
      segmentType,
      payload: data.slice(payloadStart, payloadEnd),
    });
    offset = payloadEnd;
  }

  if (packets.length === 0) throw new Error('Invalid SUP/PGS: no segments found');
  return packets;
}

function ensurePalette(palettes: Map<number, Uint8ClampedArray>, id: number): Uint8ClampedArray {
  let palette = palettes.get(id);
  if (!palette) {
    palette = new Uint8ClampedArray(256 * 4);
    palettes.set(id, palette);
  }
  return palette;
}

function applyPDS(payload: Uint8Array, palettes: Map<number, Uint8ClampedArray>) {
  if (payload.length < 2) return;
  const paletteId = payload[0] ?? 0;
  const palette = ensurePalette(palettes, paletteId);

  let offset = 2;
  while (offset + 5 <= payload.length) {
    const entryId = payload[offset] ?? 0;
    const y = payload[offset + 1] ?? 0;
    const cr = payload[offset + 2] ?? 0;
    const cb = payload[offset + 3] ?? 0;
    const alpha = payload[offset + 4] ?? 0;
    offset += 5;

    const { r, g, b } = ycbcrToRgb(y, cr, cb);
    const p = entryId * 4;
    palette[p] = r;
    palette[p + 1] = g;
    palette[p + 2] = b;
    palette[p + 3] = alpha;
  }
}

function applyODS(
  payload: Uint8Array,
  assemblies: Map<number, ObjectAssembly>,
  objects: Map<number, DecodedObject>,
) {
  if (payload.length < 4) return;
  const objectId = readU16BE(payload, 0);
  const seqDesc = payload[3] ?? 0;
  const seqFlag = seqDesc & 0xc0;
  const isFirst = seqFlag === 0x80 || seqFlag === 0xc0;
  const isLast = seqFlag === 0x40 || seqFlag === 0xc0;

  let assembly = assemblies.get(objectId) ?? null;
  let offset = 4;

  if (isFirst) {
    if (payload.length < 11) return;
    const objectDataLen = readU24BE(payload, 4);
    const width = readU16BE(payload, 7);
    const height = readU16BE(payload, 9);
    const expectedBytes = Math.max(0, objectDataLen - 4);
    offset = 11;
    assembly = { width, height, expectedBytes, chunks: [] };
    assemblies.set(objectId, assembly);
  }

  if (!assembly) return;

  const chunk = payload.subarray(offset);
  if (chunk.length > 0) assembly.chunks.push(chunk);

  if (!isLast) return;

  let total = 0;
  for (const c of assembly.chunks) total += c.length;
  let bytes = new Uint8Array(total);
  let pos = 0;
  for (const c of assembly.chunks) {
    bytes.set(c, pos);
    pos += c.length;
  }

  if (assembly.expectedBytes !== null && bytes.length > assembly.expectedBytes) {
    bytes = bytes.subarray(0, assembly.expectedBytes);
  }

  const indices = decodeObjectRle(bytes, assembly.width, assembly.height);
  objects.set(objectId, { width: assembly.width, height: assembly.height, indices });
  assemblies.delete(objectId);
}

function indicesToRgba(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: Uint8ClampedArray,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  const pxCount = width * height;
  for (let i = 0; i < pxCount; i++) {
    const idx = indices[i] ?? 0;
    const p = idx * 4;
    const o = i * 4;
    out[o] = palette[p] ?? 0;
    out[o + 1] = palette[p + 1] ?? 0;
    out[o + 2] = palette[p + 2] ?? 0;
    out[o + 3] = palette[p + 3] ?? 0;
  }
  return out;
}

async function rgbaToCanvasImageSource(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<CanvasImageSource> {
  const imageData = new ImageData(width, height);
  imageData.data.set(rgba);

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(imageData);
    } catch {
      // fall back to canvas
    }
  }

  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    canvas = c;
  } else {
    throw new Error('SUP decode: no way to create bitmap (missing createImageBitmap/canvas)');
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('SUP decode: Canvas 2D context not available');
  (ctx as any).putImageData(imageData, 0, 0);
  return canvas as any;
}

export class SupDecoder {
  async decode(data: Uint8Array): Promise<SupCue[]> {
    const packets = parseSupPackets(data);

    // Split into display sets (END = 0x80).
    const displaySets: PgsPacket[][] = [];
    let current: PgsPacket[] = [];
    for (const p of packets) {
      current.push(p);
      if (p.segmentType === 0x80) {
        displaySets.push(current);
        current = [];
      }
    }
    if (current.length > 0) displaySets.push(current);

    const palettes = new Map<number, Uint8ClampedArray>();
    const objects = new Map<number, DecodedObject>();
    const assemblies = new Map<number, ObjectAssembly>();

    const events: Event[] = [];

    for (const set of displaySets) {
      let pcs: PcsInfo | null = null;
      let pcsPts90k = 0;

      for (const seg of set) {
        switch (seg.segmentType) {
          case 0x14: // PDS
            applyPDS(seg.payload, palettes);
            break;
          case 0x15: // ODS
            applyODS(seg.payload, assemblies, objects);
            break;
          case 0x16: // PCS
            pcs = parsePCS(seg.payload);
            pcsPts90k = seg.pts90k;
            break;
          case 0x17: // WDS
          case 0x80: // END
          default:
            break;
        }
      }

      if (!pcs) continue;
      const startUs = pts90kToUs(pcsPts90k);

      if (pcs.objects.length === 0) {
        events.push({ kind: 'clear', startUs, screenW: pcs.screenW, screenH: pcs.screenH });
        continue;
      }

      const paletteCurrent = ensurePalette(palettes, pcs.paletteId);
      const paletteSnapshot = new Uint8ClampedArray(paletteCurrent);
      const resolvedObjects: ShowEvent['objects'] = [];
      for (const ref of pcs.objects) {
        const obj = objects.get(ref.objectId);
        if (!obj) continue;
        resolvedObjects.push({ object: obj, x: ref.x, y: ref.y, crop: ref.crop });
      }

      events.push({
        kind: 'show',
        startUs,
        screenW: pcs.screenW,
        screenH: pcs.screenH,
        palette: paletteSnapshot,
        objects: resolvedObjects,
      });
    }

    const cues: SupCue[] = [];
    const fallbackEndUs = 5_000_000;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.kind !== 'show') continue;

      let endUs = ev.startUs + fallbackEndUs;
      for (let j = i + 1; j < events.length; j++) {
        const nextStart = events[j].startUs;
        if (nextStart > ev.startUs) {
          endUs = nextStart;
          break;
        }
      }
      if (!Number.isFinite(endUs) || endUs <= ev.startUs) continue;

      const bitmaps: SupBitmap[] = [];
      for (const obj of ev.objects) {
        const { width, height, indices } = obj.object;
        if (width <= 0 || height <= 0) continue;
        const rgba = indicesToRgba(indices, width, height, ev.palette);
        const source = await rgbaToCanvasImageSource(rgba, width, height);
        bitmaps.push({
          source,
          width,
          height,
          x: obj.x,
          y: obj.y,
          crop: obj.crop,
        });
      }

      if (bitmaps.length === 0) continue;
      cues.push({
        startUs: ev.startUs,
        endUs,
        screenW: ev.screenW,
        screenH: ev.screenH,
        bitmaps,
      });
    }

    cues.sort((a, b) => a.startUs - b.startUs);
    return cues;
  }
}
