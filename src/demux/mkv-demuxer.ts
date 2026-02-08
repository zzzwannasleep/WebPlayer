import { extractAssTextFromDialogueLine, parseAssEventFormatFromHeader } from '../subtitle/ass-parser';
import type { ByteSource } from '../utils/byte-source';

const EBML_ID_EBML = 0x1a45dfa3;
const EBML_ID_SEGMENT = 0x18538067;

const EBML_ID_INFO = 0x1549a966;
const EBML_ID_TIMECODE_SCALE = 0x2ad7b1;

const EBML_ID_TRACKS = 0x1654ae6b;
const EBML_ID_TRACK_ENTRY = 0xae;
const EBML_ID_TRACK_NUMBER = 0xd7;
const EBML_ID_TRACK_TYPE = 0x83;
const EBML_ID_TRACK_NAME = 0x536e;
const EBML_ID_LANGUAGE = 0x22b59c;
const EBML_ID_CODEC_ID = 0x86;
const EBML_ID_CODEC_PRIVATE = 0x63a2;
const EBML_ID_DEFAULT_DURATION = 0x23e383;
const EBML_ID_VIDEO = 0xe0;
const EBML_ID_PIXEL_WIDTH = 0xb0;
const EBML_ID_PIXEL_HEIGHT = 0xba;
const EBML_ID_AUDIO = 0xe1;
const EBML_ID_SAMPLING_FREQUENCY = 0xb5;
const EBML_ID_CHANNELS = 0x9f;

const EBML_ID_CLUSTER = 0x1f43b675;
const EBML_ID_CLUSTER_TIMECODE = 0xe7;
const EBML_ID_SIMPLE_BLOCK = 0xa3;
const EBML_ID_BLOCK_GROUP = 0xa0;
const EBML_ID_BLOCK = 0xa1;
const EBML_ID_BLOCK_DURATION = 0x9b;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });

type EbmlVint = { length: number; value: number; unknown?: boolean };

function readVint(bytes: Uint8Array, offset: number): EbmlVint | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0x00) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) return null;
  if (offset + length > bytes.length) return null;

  const valueMask = 0xff >> length;

  // Value is marker-bit stripped.
  let value = first & valueMask;
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i];

  let unknown = (first & valueMask) === valueMask;
  for (let i = 1; unknown && i < length; i++) unknown = bytes[offset + i] === 0xff;

  return { length, value, unknown };
}

function readId(bytes: Uint8Array, offset: number): { length: number; id: number } | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0x00) return null;
  let mask = 0x80;
  let length = 1;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4) return null;
  if (offset + length > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[offset + i];
  return { length, id };
}

function readUnsigned(bytes: Uint8Array, offset: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + bytes[offset + i];
  return v;
}

function readSigned16(bytes: Uint8Array, offset: number): number {
  const v = (bytes[offset] << 8) | bytes[offset + 1];
  return v & 0x8000 ? v - 0x10000 : v;
}

function readFloat64(bytes: Uint8Array, offset: number, size: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  if (size === 4) return view.getFloat32(0, false);
  if (size === 8) return view.getFloat64(0, false);
  return NaN;
}

function readUtf8(bytes: Uint8Array, offset: number, size: number): string {
  const slice = bytes.subarray(offset, offset + size);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function toArrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
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

export interface MkvVideoTrackInfo {
  trackNumber: number;
  codec: string;
  width: number;
  height: number;
  description?: BufferSource;
  defaultDurationNs?: number;
}

export interface MkvAudioTrackInfo {
  trackNumber: number;
  codec: string;
  sampleRate: number;
  channelCount: number;
  description?: BufferSource;
  defaultDurationNs?: number;
}

export interface MkvSubtitleTrackInfo {
  trackNumber: number;
  codecId: string;
  name?: string;
  language?: string;
  defaultDurationNs?: number;
  assHeader?: string;
  assFormat?: string[];
}

type MkvSubtitleCue =
  | { kind: 'text'; startUs: number; endUs: number; text: string }
  | { kind: 'pgs'; data: Uint8Array };

type TrackEntryParsed = {
  trackNumber: number;
  trackType: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  defaultDurationNs: number | null;
  width: number | null;
  height: number | null;
  sampleRate: number | null;
  channels: number | null;
  name: string | null;
  language: string | null;
};

function parseAudioObjectTypeFromAsc(asc: Uint8Array): number | null {
  if (asc.length < 2) return null;
  const b0 = asc[0];
  const b1 = asc[1];
  const aot = (b0 >> 3) & 0x1f;
  if (aot === 0) return null;
  // sampling_frequency_index is (b0 & 0x07)<<1 | (b1>>7)
  // channel_configuration is (b1>>3)&0x0f
  return aot;
}

function buildHevcCodecStringFromHvcc(hvcc: Uint8Array): string | null {
  if (hvcc.length < 13) return null;
  const profileSpace = (hvcc[1] >> 6) & 0x03;
  const tierFlag = (hvcc[1] >> 5) & 0x01;
  const profileIdc = hvcc[1] & 0x1f;
  const compat = readU32BE(hvcc, 2);
  const constraint = hvcc.subarray(6, 12);
  const levelIdc = hvcc[12];

  const spaceChar = profileSpace === 0 ? '' : profileSpace === 1 ? 'A' : profileSpace === 2 ? 'B' : 'C';
  const compatHex = compat.toString(16).toUpperCase() || '0';

  let constraintHex = '';
  for (const b of constraint) constraintHex += hex2(b);
  constraintHex = constraintHex.replace(/(?:00)+$/g, '');
  constraintHex = constraintHex.replace(/^0+/g, '');
  if (constraintHex.length === 0) constraintHex = '0';
  if (constraintHex.length % 2 === 1) constraintHex = `0${constraintHex}`;

  const tier = tierFlag ? 'H' : 'L';
  return `hvc1.${spaceChar}${profileIdc}.${compatHex}.${tier}${levelIdc}.${constraintHex}`;
}

function buildVp9CodecStringFromPrivate(codecPrivate: Uint8Array | null): string {
  if (!codecPrivate || codecPrivate.length < 8) return 'vp09.00.10.08';
  const profile = codecPrivate[0] ?? 0;
  const level = codecPrivate[1] ?? 10;
  const bitDepth = codecPrivate[2] ?? 8;
  const chromaSubsampling = codecPrivate[3] ?? 1;
  const fullRange = codecPrivate[4] ?? 0;
  const colourPrimaries = codecPrivate[5] ?? 1;
  const transfer = codecPrivate[6] ?? 1;
  const matrix = codecPrivate[7] ?? 1;

  const p = String(profile).padStart(2, '0');
  const l = String(level).padStart(2, '0');
  const d = String(bitDepth).padStart(2, '0');
  const cs = String(chromaSubsampling).padStart(2, '0');
  const cp = String(colourPrimaries).padStart(2, '0');
  const tc = String(transfer).padStart(2, '0');
  const mc = String(matrix).padStart(2, '0');
  const fr = String(fullRange).padStart(2, '0');
  return `vp09.${p}.${l}.${d}.${cs}.${cp}.${tc}.${mc}.${fr}`;
}

function buildAv1CodecStringFromPrivate(codecPrivate: Uint8Array | null): string {
  if (!codecPrivate || codecPrivate.length < 4) return 'av01.0.04M.08';
  const b0 = codecPrivate[0] ?? 0;
  const version = b0 & 0x7f;
  if (version !== 1) return 'av01.0.04M.08';

  const b1 = codecPrivate[1] ?? 0;
  const seqProfile = (b1 >> 5) & 0x07;
  const seqLevelIdx0 = b1 & 0x1f;

  const b2 = codecPrivate[2] ?? 0;
  const seqTier0 = (b2 >> 7) & 0x01;
  const highBitDepth = (b2 >> 6) & 0x01;
  const twelveBit = (b2 >> 5) & 0x01;

  const tierChar = seqTier0 ? 'H' : 'M';
  const levelStr = String(seqLevelIdx0).padStart(2, '0');
  const bitDepth = highBitDepth ? (twelveBit ? 12 : 10) : 8;
  const bitDepthStr = String(bitDepth).padStart(2, '0');

  return `av01.${seqProfile}.${levelStr}${tierChar}.${bitDepthStr}`;
}

function parseOpusHeadChannels(codecPrivate: Uint8Array): number | null {
  // "OpusHead" (8 bytes) + version(1) + channels(1) + ...
  if (codecPrivate.length < 10) return null;
  const OPUS_HEAD = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64];
  for (let i = 0; i < OPUS_HEAD.length; i++) {
    if (codecPrivate[i] !== OPUS_HEAD[i]) return null;
  }
  const ch = codecPrivate[9] ?? 0;
  return ch > 0 ? ch : null;
}

function mapVideoCodec(codecId: string, codecPrivate: Uint8Array | null): { codec: string; description?: ArrayBuffer } | null {
  if (codecId === 'V_MPEG4/ISO/AVC') {
    if (!codecPrivate || codecPrivate.length < 4) return null;
    // AVCDecoderConfigurationRecord: [1]=profile, [2]=compat, [3]=level
    const profile = codecPrivate[1];
    const compat = codecPrivate[2];
    const level = codecPrivate[3];
    const codec = `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`;
    return { codec, description: toArrayBufferCopy(codecPrivate) };
  }
  if (codecId === 'V_MPEGH/ISO/HEVC') {
    if (!codecPrivate || codecPrivate.length < 13) return null;
    const codec = buildHevcCodecStringFromHvcc(codecPrivate) ?? 'hvc1';
    return { codec, description: toArrayBufferCopy(codecPrivate) };
  }
  if (codecId === 'V_VP9') {
    return { codec: buildVp9CodecStringFromPrivate(codecPrivate) };
  }
  if (codecId === 'V_AV1') {
    return { codec: buildAv1CodecStringFromPrivate(codecPrivate), description: codecPrivate ? toArrayBufferCopy(codecPrivate) : undefined };
  }
  return null;
}

function mapAudioCodec(codecId: string, codecPrivate: Uint8Array | null): { codec: string; description?: ArrayBuffer; audioObjectType?: number } | null {
  if (codecId === 'A_AAC') {
    if (!codecPrivate || codecPrivate.length < 2) return null;
    const aot = parseAudioObjectTypeFromAsc(codecPrivate) ?? 2;
    const codec = `mp4a.40.${aot}`;
    return { codec, description: toArrayBufferCopy(codecPrivate), audioObjectType: aot };
  }
  if (codecId === 'A_OPUS') {
    return { codec: 'opus', description: codecPrivate ? toArrayBufferCopy(codecPrivate) : undefined };
  }
  if (codecId === 'A_MPEG/L3') {
    return { codec: 'mp3' };
  }
  if (codecId === 'A_FLAC') {
    return { codec: 'flac', description: codecPrivate ? toArrayBufferCopy(codecPrivate) : undefined };
  }
  return null;
}

type EbmlElementHeader = {
  id: number;
  size: number | null;
  unknown: boolean;
  dataStart: number;
  dataEnd: number;
};

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class StreamByteReader {
  private buffer = new Uint8Array();
  private cursor = 0;
  private bufferStart = 0;

  constructor(
    private readonly file: ByteSource,
    private readonly chunkSize = 1024 * 1024,
  ) {}

  get pos(): number {
    return this.bufferStart + this.cursor;
  }

  private get available(): number {
    return this.buffer.length - this.cursor;
  }

  seek(pos: number) {
    const clamped = Math.max(0, Math.min(this.file.size, Math.floor(pos)));
    const bufStart = this.bufferStart;
    const bufEnd = this.bufferStart + this.buffer.length;
    if (clamped >= bufStart && clamped <= bufEnd) {
      this.cursor = clamped - bufStart;
      return;
    }

    this.bufferStart = clamped;
    this.buffer = new Uint8Array();
    this.cursor = 0;
  }

  private append(chunk: Uint8Array) {
    const unconsumed = this.buffer.subarray(this.cursor);
    const combined = new Uint8Array(unconsumed.length + chunk.length);
    combined.set(unconsumed, 0);
    combined.set(chunk, unconsumed.length);
    this.bufferStart += this.cursor;
    this.buffer = combined;
    this.cursor = 0;
  }

  async ensure(minBytes: number, maxEnd: number) {
    const end = Math.max(this.pos, Math.min(this.file.size, Math.floor(maxEnd)));
    const need = Math.max(0, Math.min(Math.floor(minBytes), end - this.pos));

    while (this.available < need) {
      const fetchStart = this.bufferStart + this.buffer.length;
      if (fetchStart >= end) break;
      const fetchEnd = Math.min(end, fetchStart + this.chunkSize);
      if (fetchEnd <= fetchStart) break;
      const buf = await this.file.slice(fetchStart, fetchEnd).arrayBuffer();
      const chunk = new Uint8Array(buf);
      if (chunk.length === 0) break;
      this.append(chunk);
    }
  }

  async readElementHeader(maxEnd: number): Promise<EbmlElementHeader | null> {
    const end = Math.max(this.pos, Math.min(this.file.size, Math.floor(maxEnd)));
    if (this.pos >= end) return null;

    await this.ensure(1, end);
    if (this.pos >= end) return null;

    await this.ensure(Math.min(4, end - this.pos), end);
    const idRes = readId(this.buffer, this.cursor);
    if (!idRes) throw new Error(`Invalid EBML ID at offset ${this.pos}`);
    this.cursor += idRes.length;

    await this.ensure(Math.min(8, end - this.pos), end);
    const sizeRes = readVint(this.buffer, this.cursor);
    if (!sizeRes) throw new Error(`Invalid EBML size at offset ${this.pos}`);
    this.cursor += sizeRes.length;

    const size = sizeRes.unknown ? null : sizeRes.value;
    const dataStart = this.pos;
    const dataEnd = size === null ? end : Math.min(end, dataStart + size);

    return { id: idRes.id, size, unknown: !!sizeRes.unknown, dataStart, dataEnd };
  }

  async readBytes(length: number, maxEnd: number): Promise<Uint8Array> {
    const end = Math.max(this.pos, Math.min(this.file.size, Math.floor(maxEnd)));
    const len = Math.max(0, Math.min(Math.floor(length), end - this.pos));
    if (len <= 0) return new Uint8Array();

    await this.ensure(len, end);
    if (this.available < len) throw new Error(`Unexpected EOF at offset ${this.pos}`);

    const out = this.buffer.subarray(this.cursor, this.cursor + len);
    this.cursor += len;
    return out;
  }
}

export class MKVDemuxer {
  private file: ByteSource | null = null;
  private segmentStart = 0;
  private segmentEnd = 0;
  private timecodeScaleNs = 1_000_000;

  private videoTrack: MkvVideoTrackInfo | null = null;
  private audioTrack: MkvAudioTrackInfo | null = null;
  private subtitleTracks: MkvSubtitleTrackInfo[] = [];

  private extractVideoTrackNo: number | null = null;
  private extractAudioTrackNo: number | null = null;
  private extractSubtitleTrackNo: number | null = null;
  private extractSubtitleTrack: MkvSubtitleTrackInfo | null = null;
  private pendingSubtitle: { startUs: number; text: string } | null = null;

  private stopped = false;
  private paused = false;
  private extracting = false;
  private resumeWaiters: Array<() => void> = [];
  private startScheduled = false;

  private onVideoChunk: ((chunk: EncodedVideoChunk) => void) | null = null;
  private onVideoEnd: (() => void) | null = null;
  private onAudioChunk: ((chunk: EncodedAudioChunk) => void) | null = null;
  private onAudioEnd: (() => void) | null = null;
  private onSubtitleCue: ((cue: MkvSubtitleCue) => void) | null = null;
  private onSubtitleEnd: (() => void) | null = null;
  private extractPromise: Promise<void> | null = null;
  private pgsExtractSeq = 0;

  async open(file: ByteSource) {
    this.stop();
    this.stopped = false;
    this.file = file;
    this.segmentStart = 0;
    this.segmentEnd = file.size;
    this.timecodeScaleNs = 1_000_000;
    this.videoTrack = null;
    this.audioTrack = null;
    this.subtitleTracks = [];
    this.extractVideoTrackNo = null;
    this.extractAudioTrackNo = null;
    this.extractSubtitleTrackNo = null;
    this.extractSubtitleTrack = null;
    this.pendingSubtitle = null;

    await this.parseSegmentAndTracks();
  }

  async getPrimaryVideoTrack(): Promise<MkvVideoTrackInfo> {
    if (!this.file) throw new Error('Demuxer not opened');
    if (!this.videoTrack) throw new Error('No supported video track found in MKV');
    return this.videoTrack;
  }

  async getPrimaryAudioTrack(): Promise<MkvAudioTrackInfo> {
    if (!this.file) throw new Error('Demuxer not opened');
    if (!this.audioTrack) throw new Error('No supported audio track found in MKV');
    return this.audioTrack;
  }

  async getSubtitleTracks(): Promise<MkvSubtitleTrackInfo[]> {
    if (!this.file) throw new Error('Demuxer not opened');
    return this.subtitleTracks;
  }

  startVideoExtraction(
    track: MkvVideoTrackInfo,
    onChunk: (chunk: EncodedVideoChunk) => void,
    onEnd: () => void,
  ) {
    this.onVideoChunk = onChunk;
    this.onVideoEnd = onEnd;
    this.extractVideoTrackNo = track.trackNumber;
    this.extracting = true;
    this.scheduleExtractLoopStart();
  }

  startAudioExtraction(
    track: MkvAudioTrackInfo,
    onChunk: (chunk: EncodedAudioChunk) => void,
    onEnd: () => void,
  ) {
    this.onAudioChunk = onChunk;
    this.onAudioEnd = onEnd;
    this.extractAudioTrackNo = track.trackNumber;
    this.extracting = true;
    this.scheduleExtractLoopStart();
  }

  startSubtitleExtraction(
    track: MkvSubtitleTrackInfo,
    onCue: (cue: MkvSubtitleCue) => void,
    onEnd: () => void,
  ) {
    this.onSubtitleCue = onCue;
    this.onSubtitleEnd = onEnd;
    this.extractSubtitleTrack = track;
    this.pendingSubtitle = null;

    const codecId = track.codecId;
    if (codecId === 'S_HDMV/PGS') {
      this.extractSubtitleTrackNo = null;

      const seq = ++this.pgsExtractSeq;
      const isAborted = () => this.stopped || seq !== this.pgsExtractSeq;
      this.extractPgsSupBytes(track.trackNumber, isAborted)
        .then((data) => {
          if (isAborted()) return;
          if (!data || data.length === 0) return;
          this.onSubtitleCue?.({ kind: 'pgs', data });
        })
        .finally(() => {
          if (isAborted()) return;
          this.onSubtitleEnd?.();
        });
      return;
    }

    // Text subtitles.
    this.pgsExtractSeq += 1;
    this.extractSubtitleTrackNo = track.trackNumber;
    this.extracting = true;
    this.scheduleExtractLoopStart();
  }

  stopSubtitleExtraction() {
    this.pgsExtractSeq += 1;
    this.onSubtitleCue = null;
    this.onSubtitleEnd = null;
    this.extractSubtitleTrackNo = null;
    this.extractSubtitleTrack = null;
    this.pendingSubtitle = null;
  }

  stop() {
    this.pgsExtractSeq += 1;
    this.stopped = true;
    this.extracting = false;
    this.paused = false;
    this.wakeAllResumeWaiters();
    try {
      this.file?.abort?.();
    } catch {
      // ignore
    }
    this.file = null;
    this.onVideoChunk = null;
    this.onVideoEnd = null;
    this.onAudioChunk = null;
    this.onAudioEnd = null;
    this.onSubtitleCue = null;
    this.onSubtitleEnd = null;
    this.pendingSubtitle = null;
    this.extractVideoTrackNo = null;
    this.extractAudioTrackNo = null;
    this.extractSubtitleTrackNo = null;
    this.extractSubtitleTrack = null;
    this.startScheduled = false;
    this.extractPromise = null;
  }

  pauseExtraction() {
    if (this.stopped || !this.extracting) return;
    this.paused = true;
  }

  resumeExtraction() {
    if (this.stopped || !this.extracting) return;
    this.paused = false;
    this.wakeAllResumeWaiters();
  }

  private wakeAllResumeWaiters() {
    const waiters = this.resumeWaiters;
    if (waiters.length === 0) return;
    this.resumeWaiters = [];
    for (const w of waiters) w();
  }

  private async waitIfPaused() {
    while (this.paused && !this.stopped) {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
  }

  private scheduleExtractLoopStart() {
    if (this.extractPromise || this.startScheduled) return;
    this.startScheduled = true;
    queueMicrotask(() => {
      this.startScheduled = false;
      if (this.extractPromise || this.stopped || !this.extracting) return;
      this.extractPromise = this.runExtractLoop().catch(() => {});
    });
  }

  private async parseSegmentAndTracks() {
    const file = this.file;
    if (!file) throw new Error('Demuxer not opened');

    // Locate Segment element.
    const rootReader = new StreamByteReader(file, 256 * 1024);
    let segment: EbmlElementHeader | null = null;
    let steps = 0;

    while (rootReader.pos < file.size && !this.stopped) {
      const header = await rootReader.readElementHeader(file.size);
      if (!header) break;
      if (header.id === EBML_ID_SEGMENT) {
        segment = header;
        break;
      }
      rootReader.seek(header.dataEnd);
      steps += 1;
      if (steps % 200 === 0) await yieldToMain();
    }

    if (!segment) throw new Error('Invalid MKV: Segment element not found');
    this.segmentStart = segment.dataStart;
    this.segmentEnd = segment.dataEnd;

    // Parse Info + Tracks within Segment.
    const segReader = new StreamByteReader(file, 512 * 1024);
    segReader.seek(this.segmentStart);
    const trackEntries: TrackEntryParsed[] = [];
    let parsedInfo = false;
    let parsedTracks = false;
    steps = 0;

    while (
      segReader.pos < this.segmentEnd &&
      !this.stopped &&
      (!parsedInfo || !parsedTracks)
    ) {
      const header = await segReader.readElementHeader(this.segmentEnd);
      if (!header) break;

      if (header.id === EBML_ID_INFO && header.size !== null) {
        const data = await segReader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
        this.parseInfo(data, 0, data.length);
        parsedInfo = true;
      } else if (header.id === EBML_ID_TRACKS && header.size !== null) {
        const data = await segReader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
        this.parseTracks(data, 0, data.length, trackEntries);
        parsedTracks = true;
      } else {
        segReader.seek(header.dataEnd);
      }

      steps += 1;
      if (steps % 200 === 0) await yieldToMain();
    }

    this.applyTrackEntries(trackEntries);
  }

  private applyTrackEntries(trackEntries: TrackEntryParsed[]) {
    // Pick primary tracks (first supported).
    const subtitleTracks: MkvSubtitleTrackInfo[] = [];
    for (const t of trackEntries) {
      if (!this.videoTrack && t.trackType === 1) {
        const mapped = mapVideoCodec(t.codecId, t.codecPrivate);
        if (mapped) {
          this.videoTrack = {
            trackNumber: t.trackNumber,
            codec: mapped.codec,
            width: t.width ?? 0,
            height: t.height ?? 0,
            description: mapped.description,
            defaultDurationNs: t.defaultDurationNs ?? undefined,
          };
        }
      } else if (!this.audioTrack && t.trackType === 2) {
        const mapped = mapAudioCodec(t.codecId, t.codecPrivate);
        if (mapped) {
          let sampleRate = t.sampleRate ?? 0;
          let channelCount = t.channels ?? 0;
          if (mapped.codec === 'opus') {
            sampleRate = 48000;
            if (!(Number.isFinite(channelCount) && channelCount > 0) && t.codecPrivate) {
              channelCount = parseOpusHeadChannels(t.codecPrivate) ?? 0;
            }
          }
          this.audioTrack = {
            trackNumber: t.trackNumber,
            codec: mapped.codec,
            sampleRate,
            channelCount,
            description: mapped.description,
            defaultDurationNs: t.defaultDurationNs ?? undefined,
          };
        }
      } else if (t.trackType === 17) {
        const name = t.name ?? undefined;
        const language = t.language ?? undefined;
        if (t.codecId === 'S_TEXT/UTF8') {
          subtitleTracks.push({
            trackNumber: t.trackNumber,
            codecId: t.codecId,
            name,
            language,
            defaultDurationNs: t.defaultDurationNs ?? undefined,
          });
        } else if (t.codecId === 'S_TEXT/ASS' || t.codecId === 'S_TEXT/SSA') {
          const header = t.codecPrivate ? UTF8_DECODER.decode(t.codecPrivate) : '';
          const format = header ? parseAssEventFormatFromHeader(header) : undefined;
          subtitleTracks.push({
            trackNumber: t.trackNumber,
            codecId: t.codecId,
            name,
            language,
            defaultDurationNs: t.defaultDurationNs ?? undefined,
            assHeader: header || undefined,
            assFormat: format,
          });
        } else if (t.codecId === 'S_HDMV/PGS') {
          subtitleTracks.push({
            trackNumber: t.trackNumber,
            codecId: t.codecId,
            name,
            language,
            defaultDurationNs: t.defaultDurationNs ?? undefined,
          });
        }
      }
    }
    this.subtitleTracks = subtitleTracks;
  }

  private parseInfo(bytes: Uint8Array, start: number, end: number) {
    let pos = start;
    while (pos < end) {
      const idRes = readId(bytes, pos);
      if (!idRes) break;
      pos += idRes.length;
      const sizeRes = readVint(bytes, pos);
      if (!sizeRes) break;
      pos += sizeRes.length;
      const size = sizeRes.unknown ? null : sizeRes.value;
      const dataStart = pos;
      const dataEnd = size === null ? end : Math.min(end, pos + size);

      if (idRes.id === EBML_ID_TIMECODE_SCALE && size !== null && size > 0 && size <= 8) {
        const v = readUnsigned(bytes, dataStart, size);
        if (Number.isFinite(v) && v > 0) this.timecodeScaleNs = v;
      }
      pos = dataEnd;
    }
  }

  private parseTracks(bytes: Uint8Array, start: number, end: number, out: TrackEntryParsed[]) {
    let pos = start;
    while (pos < end) {
      const idRes = readId(bytes, pos);
      if (!idRes) break;
      pos += idRes.length;
      const sizeRes = readVint(bytes, pos);
      if (!sizeRes) break;
      pos += sizeRes.length;
      const size = sizeRes.unknown ? null : sizeRes.value;
      const dataStart = pos;
      const dataEnd = size === null ? end : Math.min(end, pos + size);

      if (idRes.id === EBML_ID_TRACK_ENTRY) {
        const parsed = this.parseTrackEntry(bytes, dataStart, dataEnd);
        if (parsed) out.push(parsed);
      }
      pos = dataEnd;
    }
  }

  private parseTrackEntry(bytes: Uint8Array, start: number, end: number): TrackEntryParsed | null {
    let pos = start;

    let trackNumber: number | null = null;
    let trackType: number | null = null;
    let codecId: string | null = null;
    let codecPrivate: Uint8Array | null = null;
    let defaultDurationNs: number | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let sampleRate: number | null = null;
    let channels: number | null = null;
    let name: string | null = null;
    let language: string | null = null;

    while (pos < end) {
      const idRes = readId(bytes, pos);
      if (!idRes) break;
      pos += idRes.length;
      const sizeRes = readVint(bytes, pos);
      if (!sizeRes) break;
      pos += sizeRes.length;
      const size = sizeRes.unknown ? null : sizeRes.value;
      const dataStart = pos;
      const dataEnd = size === null ? end : Math.min(end, pos + size);

      if (idRes.id === EBML_ID_TRACK_NUMBER && size !== null && size > 0 && size <= 8) {
        trackNumber = readUnsigned(bytes, dataStart, size);
      } else if (idRes.id === EBML_ID_TRACK_TYPE && size !== null && size > 0 && size <= 8) {
        trackType = readUnsigned(bytes, dataStart, size);
      } else if (idRes.id === EBML_ID_TRACK_NAME && size !== null) {
        name = readUtf8(bytes, dataStart, size);
      } else if (idRes.id === EBML_ID_LANGUAGE && size !== null) {
        language = readUtf8(bytes, dataStart, size);
      } else if (idRes.id === EBML_ID_CODEC_ID && size !== null) {
        codecId = readUtf8(bytes, dataStart, size);
      } else if (idRes.id === EBML_ID_CODEC_PRIVATE && size !== null) {
        codecPrivate = bytes.slice(dataStart, dataEnd);
      } else if (idRes.id === EBML_ID_DEFAULT_DURATION && size !== null && size > 0 && size <= 8) {
        defaultDurationNs = readUnsigned(bytes, dataStart, size);
      } else if (idRes.id === EBML_ID_VIDEO && size !== null) {
        const v = this.parseVideo(bytes, dataStart, dataEnd);
        if (typeof v.width === 'number') width = v.width;
        if (typeof v.height === 'number') height = v.height;
      } else if (idRes.id === EBML_ID_AUDIO && size !== null) {
        const a = this.parseAudio(bytes, dataStart, dataEnd);
        if (typeof a.sampleRate === 'number') sampleRate = a.sampleRate;
        if (typeof a.channels === 'number') channels = a.channels;
      }

      pos = dataEnd;
    }

    if (
      trackNumber === null ||
      trackType === null ||
      codecId === null
    ) {
      return null;
    }

    return {
      trackNumber,
      trackType,
      codecId,
      codecPrivate,
      defaultDurationNs,
      width,
      height,
      sampleRate,
      channels,
      name,
      language,
    };
  }

  private parseVideo(bytes: Uint8Array, start: number, end: number): { width?: number; height?: number } {
    let pos = start;
    let width: number | undefined;
    let height: number | undefined;
    while (pos < end) {
      const idRes = readId(bytes, pos);
      if (!idRes) break;
      pos += idRes.length;
      const sizeRes = readVint(bytes, pos);
      if (!sizeRes) break;
      pos += sizeRes.length;
      const size = sizeRes.unknown ? null : sizeRes.value;
      const dataStart = pos;
      const dataEnd = size === null ? end : Math.min(end, pos + size);

      if (idRes.id === EBML_ID_PIXEL_WIDTH && size !== null && size > 0 && size <= 8) {
        width = readUnsigned(bytes, dataStart, size);
      } else if (idRes.id === EBML_ID_PIXEL_HEIGHT && size !== null && size > 0 && size <= 8) {
        height = readUnsigned(bytes, dataStart, size);
      }
      pos = dataEnd;
    }
    return { width, height };
  }

  private parseAudio(bytes: Uint8Array, start: number, end: number): { sampleRate?: number; channels?: number } {
    let pos = start;
    let sampleRate: number | undefined;
    let channels: number | undefined;
    while (pos < end) {
      const idRes = readId(bytes, pos);
      if (!idRes) break;
      pos += idRes.length;
      const sizeRes = readVint(bytes, pos);
      if (!sizeRes) break;
      pos += sizeRes.length;
      const size = sizeRes.unknown ? null : sizeRes.value;
      const dataStart = pos;
      const dataEnd = size === null ? end : Math.min(end, pos + size);

      if (idRes.id === EBML_ID_SAMPLING_FREQUENCY && size !== null) {
        const v = readFloat64(bytes, dataStart, size);
        if (Number.isFinite(v) && v > 0) sampleRate = v;
      } else if (idRes.id === EBML_ID_CHANNELS && size !== null && size > 0 && size <= 8) {
        channels = readUnsigned(bytes, dataStart, size);
      }
      pos = dataEnd;
    }

    return { sampleRate, channels };
  }

  private async runExtractLoop() {
    const file = this.file;
    if (!file) throw new Error('Demuxer not opened');
    const end = this.segmentEnd || file.size;
    const reader = new StreamByteReader(file, 1024 * 1024);
    reader.seek(this.segmentStart);

    let clusterTimecode = 0;
    let pendingVideo: { timestampUs: number; data: Uint8Array; key: boolean } | null = null;

    let steps = 0;

    while (reader.pos < end && !this.stopped) {
      await this.waitIfPaused();

      const videoTrackNo = this.extractVideoTrackNo ?? this.videoTrack?.trackNumber ?? null;
      const audioTrackNo = this.extractAudioTrackNo ?? this.audioTrack?.trackNumber ?? null;
      const subtitleTrackNo = this.extractSubtitleTrackNo;

      const header = await reader.readElementHeader(end);
      if (!header) break;

      if (header.id === EBML_ID_CLUSTER) {
        const res = await this.parseCluster(
          reader,
          header.dataEnd,
          clusterTimecode,
          videoTrackNo,
          audioTrackNo,
          subtitleTrackNo,
          pendingVideo,
        );
        clusterTimecode = res.clusterTimecode;
        pendingVideo = res.pendingVideo;
      } else {
        reader.seek(header.dataEnd);
      }

      steps += 1;
      if (steps % 200 === 0) {
        // Yield to keep UI responsive.
        await yieldToMain();
      }
    }

    if (pendingVideo && this.onVideoChunk) {
      this.onVideoChunk(
        new EncodedVideoChunk({
          type: pendingVideo.key ? 'key' : 'delta',
          timestamp: pendingVideo.timestampUs,
          duration: 0,
          data: pendingVideo.data,
        }),
      );
    }

    if (this.onVideoEnd) this.onVideoEnd();
    if (this.onAudioEnd) this.onAudioEnd();
    this.flushPendingSubtitle(null);
    if (this.onSubtitleEnd) this.onSubtitleEnd();
  }

  private async parseCluster(
    reader: StreamByteReader,
    end: number,
    prevClusterTimecode: number,
    videoTrackNo: number | null,
    audioTrackNo: number | null,
    subtitleTrackNo: number | null,
    pendingVideo: { timestampUs: number; data: Uint8Array; key: boolean } | null,
  ): Promise<{ clusterTimecode: number; pendingVideo: { timestampUs: number; data: Uint8Array; key: boolean } | null }> {
    let clusterTimecode = prevClusterTimecode;
    let steps = 0;

    while (reader.pos < end && !this.stopped) {
      if (this.paused) await this.waitIfPaused();

      const header = await reader.readElementHeader(end);
      if (!header) break;

      if (header.id === EBML_ID_CLUSTER_TIMECODE && header.size !== null && header.size > 0 && header.size <= 8) {
        const v = await reader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
        clusterTimecode = readUnsigned(v, 0, v.length);
      } else if (header.id === EBML_ID_SIMPLE_BLOCK && header.size !== null) {
        const block = await reader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
        pendingVideo = this.handleBlock(block, clusterTimecode, videoTrackNo, audioTrackNo, subtitleTrackNo, pendingVideo, true, null);
      } else if (header.id === EBML_ID_BLOCK_GROUP) {
        pendingVideo = await this.parseBlockGroup(reader, header.dataEnd, clusterTimecode, videoTrackNo, audioTrackNo, subtitleTrackNo, pendingVideo);
      } else {
        reader.seek(header.dataEnd);
      }

      steps += 1;
      if (steps % 400 === 0) await yieldToMain();
    }

    reader.seek(end);
    return { clusterTimecode, pendingVideo };
  }

  private async parseBlockGroup(
    reader: StreamByteReader,
    end: number,
    clusterTimecode: number,
    videoTrackNo: number | null,
    audioTrackNo: number | null,
    subtitleTrackNo: number | null,
    pendingVideo: { timestampUs: number; data: Uint8Array; key: boolean } | null,
  ) {
    let durationTicks: number | null = null;
    let blockBytes: Uint8Array | null = null;

    while (reader.pos < end && !this.stopped) {
      if (this.paused) await this.waitIfPaused();

      const header = await reader.readElementHeader(end);
      if (!header) break;

      if (header.id === EBML_ID_BLOCK_DURATION && header.size !== null && header.size > 0 && header.size <= 8) {
        const v = await reader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
        durationTicks = readUnsigned(v, 0, v.length);
      } else if (header.id === EBML_ID_BLOCK && header.size !== null) {
        blockBytes = await reader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
      } else {
        reader.seek(header.dataEnd);
      }
    }

    reader.seek(end);
    if (blockBytes) {
      pendingVideo = this.handleBlock(blockBytes, clusterTimecode, videoTrackNo, audioTrackNo, subtitleTrackNo, pendingVideo, false, durationTicks);
    }
    return pendingVideo;
  }

  private async extractPgsSupBytes(trackNo: number, isAborted: () => boolean): Promise<Uint8Array> {
    const file = this.file;
    if (!file) return new Uint8Array();
    const end = this.segmentEnd || file.size;
    const reader = new StreamByteReader(file, 1024 * 1024);
    reader.seek(this.segmentStart);

    let clusterTimecode = 0;
    const chunks: Uint8Array[] = [];
    let total = 0;
    let steps = 0;

    while (reader.pos < end && !this.stopped && !isAborted()) {
      if (this.paused) await this.waitIfPaused();

      const header = await reader.readElementHeader(end);
      if (!header) break;

      if (header.id === EBML_ID_CLUSTER) {
        const res = await this.collectPgsFromCluster(
          reader,
          header.dataEnd,
          clusterTimecode,
          trackNo,
          chunks,
          isAborted,
        );
        clusterTimecode = res.clusterTimecode;
        total += res.addedBytes;
      } else {
        reader.seek(header.dataEnd);
      }

      steps += 1;
      if (steps % 200 === 0) await yieldToMain();
    }

    if (total <= 0) return new Uint8Array();
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  private async collectPgsFromCluster(
    reader: StreamByteReader,
    end: number,
    prevClusterTimecode: number,
    trackNo: number,
    out: Uint8Array[],
    isAborted: () => boolean,
  ): Promise<{ clusterTimecode: number; addedBytes: number }> {
    let clusterTimecode = prevClusterTimecode;
    let addedBytes = 0;
    let steps = 0;

    while (reader.pos < end && !this.stopped && !isAborted()) {
      if (this.paused) await this.waitIfPaused();

      const header = await reader.readElementHeader(end);
      if (!header) break;

      if (header.id === EBML_ID_CLUSTER_TIMECODE && header.size !== null && header.size > 0 && header.size <= 8) {
        const v = await reader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
        clusterTimecode = readUnsigned(v, 0, v.length);
      } else if (header.id === EBML_ID_SIMPLE_BLOCK && header.size !== null) {
        const block = await reader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
        addedBytes += this.collectPgsFromBlock(block, clusterTimecode, trackNo, out);
      } else if (header.id === EBML_ID_BLOCK_GROUP) {
        const res = await this.collectPgsFromBlockGroup(
          reader,
          header.dataEnd,
          clusterTimecode,
          trackNo,
          out,
          isAborted,
        );
        addedBytes += res.addedBytes;
      } else {
        reader.seek(header.dataEnd);
      }

      steps += 1;
      if (steps % 400 === 0) await yieldToMain();
    }

    reader.seek(end);
    return { clusterTimecode, addedBytes };
  }

  private async collectPgsFromBlockGroup(
    reader: StreamByteReader,
    end: number,
    clusterTimecode: number,
    trackNo: number,
    out: Uint8Array[],
    isAborted: () => boolean,
  ): Promise<{ addedBytes: number }> {
    let blockBytes: Uint8Array | null = null;
    let steps = 0;

    while (reader.pos < end && !this.stopped && !isAborted()) {
      if (this.paused) await this.waitIfPaused();

      const header = await reader.readElementHeader(end);
      if (!header) break;

      if (header.id === EBML_ID_BLOCK && header.size !== null) {
        blockBytes = await reader.readBytes(header.dataEnd - header.dataStart, header.dataEnd);
      } else {
        reader.seek(header.dataEnd);
      }

      steps += 1;
      if (steps % 600 === 0) await yieldToMain();
    }

    reader.seek(end);
    if (!blockBytes) return { addedBytes: 0 };
    const addedBytes = this.collectPgsFromBlock(blockBytes, clusterTimecode, trackNo, out);
    return { addedBytes };
  }

  private collectPgsFromBlock(
    block: Uint8Array,
    clusterTimecode: number,
    targetTrackNo: number,
    out: Uint8Array[],
  ): number {
    // TrackNumber (VINT), Timecode (int16), Flags (u8)
    const trackV = readVint(block, 0);
    if (!trackV) return 0;
    const trackNo = trackV.value;
    let pos = trackV.length;
    if (pos + 3 > block.length) return 0;
    const relTimecode = readSigned16(block, pos);
    pos += 2;
    const flags = block[pos] ?? 0;
    pos += 1;

    const lacing = (flags >> 1) & 0x03;

    // Skip lacing headers if present and keep concatenated frames as one payload.
    if (lacing !== 0) {
      if (pos >= block.length) return 0;
      const numFrames = (block[pos] ?? 0) + 1;
      pos += 1;
      if (numFrames <= 1) return 0;
      if (lacing === 1) {
        // Xiph lacing.
        for (let i = 0; i < numFrames - 1; i++) {
          while (pos < block.length) {
            const b = block[pos++];
            if (b !== 0xff) break;
          }
          if (pos >= block.length) break;
        }
      } else if (lacing === 2) {
        // Fixed-size lacing: no extra sizes.
      } else if (lacing === 3) {
        // EBML lacing: first size is vint, then signed diffs.
        const firstSize = readVint(block, pos);
        if (!firstSize) return 0;
        pos += firstSize.length;
        for (let i = 1; i < numFrames - 1; i++) {
          const diff = readVint(block, pos);
          if (!diff) return 0;
          pos += diff.length;
        }
      }
    }

    if (pos >= block.length) return 0;
    if (trackNo !== targetTrackNo) return 0;

    const payload = block.subarray(pos);

    const timecode = clusterTimecode + relTimecode;
    const timestampUs = Math.round((timecode * this.timecodeScaleNs) / 1000);
    const pts90k = Math.max(0, Math.round((timestampUs * 90_000) / 1_000_000)) >>> 0;

    const writeU32BE = (buf: Uint8Array, off: number, v: number) => {
      buf[off] = (v >>> 24) & 0xff;
      buf[off + 1] = (v >>> 16) & 0xff;
      buf[off + 2] = (v >>> 8) & 0xff;
      buf[off + 3] = v & 0xff;
    };

    // MKV PGS blocks are commonly either:
    // - full "PG" packets (like .sup), or
    // - raw PGS segments (segment_type + segment_length + payload...) with MKV timestamps.
    if (payload.length >= 13 && payload[0] === 0x50 && payload[1] === 0x47) {
      const copy = payload.slice();
      out.push(copy);
      return copy.length;
    }

    let added = 0;
    let p = 0;
    while (p + 3 <= payload.length) {
      const segType = payload[p] ?? 0;
      const segLen = ((payload[p + 1] ?? 0) << 8) | (payload[p + 2] ?? 0);
      p += 3;
      if (p + segLen > payload.length) break;

      const packet = new Uint8Array(13 + segLen);
      packet[0] = 0x50;
      packet[1] = 0x47;
      writeU32BE(packet, 2, pts90k);
      writeU32BE(packet, 6, pts90k);
      packet[10] = segType;
      packet[11] = (segLen >>> 8) & 0xff;
      packet[12] = segLen & 0xff;
      packet.set(payload.subarray(p, p + segLen), 13);

      out.push(packet);
      added += packet.length;
      p += segLen;
    }

    return added;
  }

  private handleBlock(
    block: Uint8Array,
    clusterTimecode: number,
    videoTrackNo: number | null,
    audioTrackNo: number | null,
    subtitleTrackNo: number | null,
    pendingVideo: { timestampUs: number; data: Uint8Array; key: boolean } | null,
    isSimpleBlock: boolean,
    blockDurationTicks: number | null,
  ) {
    // TrackNumber (VINT), Timecode (int16), Flags (u8)
    const trackV = readVint(block, 0);
    if (!trackV) return pendingVideo;
    const trackNo = trackV.value;
    let pos = trackV.length;
    if (pos + 3 > block.length) return pendingVideo;
    const relTimecode = readSigned16(block, pos);
    pos += 2;
    const flags = block[pos];
    pos += 1;

    const lacing = (flags >> 1) & 0x03;
    const key = isSimpleBlock ? (flags & 0x80) !== 0 : false;

    if (lacing !== 0 && trackNo === videoTrackNo) {
      // Keep it simple: video lacing is rare; not handled yet.
      return pendingVideo;
    }

    // Skip lacing headers if present and keep concatenated frames as one chunk.
    if (lacing !== 0) {
      if (pos >= block.length) return pendingVideo;
      const numFrames = block[pos] + 1;
      pos += 1;
      if (numFrames <= 1) return pendingVideo;
      if (lacing === 1) {
        // Xiph lacing.
        for (let i = 0; i < numFrames - 1; i++) {
          let sz = 0;
          while (pos < block.length) {
            const b = block[pos++];
            sz += b;
            if (b !== 0xff) break;
          }
          if (pos >= block.length) break;
          // size value ignored (we keep concatenated data)
          void sz;
        }
      } else if (lacing === 2) {
        // Fixed-size lacing: no extra sizes.
      } else if (lacing === 3) {
        // EBML lacing: first size is vint, then signed diffs.
        const firstSize = readVint(block, pos);
        if (!firstSize) return pendingVideo;
        pos += firstSize.length;
        for (let i = 1; i < numFrames - 1; i++) {
          const diff = readVint(block, pos);
          if (!diff) return pendingVideo;
          pos += diff.length;
        }
      }
    }

    if (pos >= block.length) return pendingVideo;
    const payload = block.subarray(pos);

    const timecode = clusterTimecode + relTimecode;
    const timestampUs = Math.round((timecode * this.timecodeScaleNs) / 1000);

    if (trackNo === audioTrackNo && this.onAudioChunk) {
      this.onAudioChunk(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: timestampUs,
          duration: 0,
          data: payload,
        }),
      );
      return pendingVideo;
    }

    if (trackNo === subtitleTrackNo && this.onSubtitleCue) {
      const track = this.extractSubtitleTrack;
      const codecId = track?.codecId ?? '';
      if (codecId === 'S_HDMV/PGS') return pendingVideo;
      const raw = UTF8_DECODER.decode(payload).replace(/\0+$/g, '').trim();
      if (raw) {
        const text =
          codecId === 'S_TEXT/ASS' || codecId === 'S_TEXT/SSA'
            ? extractAssTextFromDialogueLine(raw, track?.assFormat)
            : raw;

        if (text) {
          let durationUs = 0;
          if (
            typeof blockDurationTicks === 'number' &&
            Number.isFinite(blockDurationTicks) &&
            blockDurationTicks > 0
          ) {
            durationUs = Math.round((blockDurationTicks * this.timecodeScaleNs) / 1000);
          } else if (track?.defaultDurationNs && track.defaultDurationNs > 0) {
            durationUs = Math.round(track.defaultDurationNs / 1000);
          }

          this.flushPendingSubtitle(timestampUs);

          if (durationUs > 0) {
            const endUs = timestampUs + durationUs;
            if (endUs > timestampUs) this.onSubtitleCue({ kind: 'text', startUs: timestampUs, endUs, text });
          } else {
            this.pendingSubtitle = { startUs: timestampUs, text };
          }
        }
      }
      return pendingVideo;
    }

    if (trackNo === videoTrackNo && this.onVideoChunk) {
      const current = { timestampUs, data: payload, key };
      if (pendingVideo) {
        const dur = current.timestampUs - pendingVideo.timestampUs;
        const durationUs = Number.isFinite(dur) && dur > 0 ? dur : 0;
        this.onVideoChunk(
          new EncodedVideoChunk({
            type: pendingVideo.key ? 'key' : 'delta',
            timestamp: pendingVideo.timestampUs,
            duration: durationUs,
            data: pendingVideo.data,
          }),
        );
      }
      return current;
    }

    return pendingVideo;
  }

  private flushPendingSubtitle(nextStartUs: number | null) {
    const pending = this.pendingSubtitle;
    const onCue = this.onSubtitleCue;
    if (!pending || !onCue) return;

    const startUs = pending.startUs;
    let endUs = nextStartUs ?? 0;
    if (!(Number.isFinite(endUs) && endUs > startUs)) {
      const fallback =
        this.extractSubtitleTrack?.defaultDurationNs && this.extractSubtitleTrack.defaultDurationNs > 0
          ? Math.round(this.extractSubtitleTrack.defaultDurationNs / 1000)
          : 5_000_000;
      endUs = startUs + fallback;
    }

    this.pendingSubtitle = null;
    if (endUs > startUs) onCue({ kind: 'text', startUs, endUs, text: pending.text });
  }
}
