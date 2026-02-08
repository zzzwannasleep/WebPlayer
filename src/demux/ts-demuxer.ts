import type { ByteSource } from '../utils/byte-source';

const TS_PACKET_SIZE = 188;
const TS_STRIDE_CANDIDATES = [188, 192, 204] as const;

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

export interface TsVideoTrackInfo {
  pid: number;
  codec: string;
  width: number;
  height: number;
  description?: BufferSource;
}

export interface TsAudioTrackInfo {
  pid: number;
  codec: string;
  sampleRate: number;
  channelCount: number;
  description?: BufferSource;
  samplesPerFrame?: number;
}

type PsiAssembly = {
  data: Uint8Array;
  totalLength: number | null;
};

type PesAssembly = {
  pts90k: number | null;
  chunks: Uint8Array[];
  length: number;
};

function pts90kToUs(pts90k: number): number {
  return Math.round((pts90k * 1_000_000) / 90_000);
}

function hex2(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

function concatChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function detectTsPacketStrideAndSyncOffset(data: Uint8Array): { stride: number; syncOffset: number } | null {
  const maxCheckPackets = 5;
  let best: { stride: number; syncOffset: number; okCount: number } | null = null;

  for (const stride of TS_STRIDE_CANDIDATES) {
    const maxOffset = Math.min(stride, Math.max(0, data.length - stride * maxCheckPackets));
    for (let syncOffset = 0; syncOffset < maxOffset; syncOffset++) {
      let okCount = 0;
      for (let i = 0; i < maxCheckPackets; i++) {
        const idx = syncOffset + i * stride;
        if (idx >= data.length) break;
        if (data[idx] !== 0x47) {
          okCount = -1;
          break;
        }
        okCount += 1;
      }
      if (okCount <= 0) continue;
      if (
        !best ||
        okCount > best.okCount ||
        (okCount === best.okCount && stride < best.stride)
      ) {
        best = { stride, syncOffset, okCount };
      }
    }
  }

  return best ? { stride: best.stride, syncOffset: best.syncOffset } : null;
}

function parseTsPayload(pkt: Uint8Array): { payloadUnitStart: boolean; pid: number; payload: Uint8Array } | null {
  if (pkt.length < TS_PACKET_SIZE) return null;
  if (pkt[0] !== 0x47) return null;
  const payloadUnitStart = (pkt[1] & 0x40) !== 0;
  const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
  const afc = (pkt[3] >> 4) & 0x03;
  let p = 4;
  if (afc === 0x00 || afc === 0x02) return null; // no payload
  if (afc === 0x03) {
    if (p >= pkt.length) return null;
    const afl = pkt[p];
    p += 1 + afl;
  }
  if (p >= pkt.length) return null;
  return { payloadUnitStart, pid, payload: pkt.subarray(p) };
}

function parsePsiSection(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 1) return null;
  const pointer = payload[0];
  if (pointer + 1 >= payload.length) return null;
  return payload.subarray(1 + pointer);
}

function tryParseSectionTotalLength(sectionStart: Uint8Array): number | null {
  if (sectionStart.length < 3) return null;
  const sectionLength = ((sectionStart[1] & 0x0f) << 8) | sectionStart[2];
  return 3 + sectionLength;
}

function parsePatForPmtPid(section: Uint8Array): number | null {
  // Table ID 0x00
  if (section.length < 8) return null;
  if (section[0] !== 0x00) return null;
  const total = tryParseSectionTotalLength(section);
  if (!total || section.length < total) return null;

  // Skip: table_id (1) + section_length(2) + tsid(2) + ver/cni(1) + section#(1) + last#(1)
  let offset = 8;
  const end = total - 4; // exclude CRC
  while (offset + 4 <= end) {
    const programNumber = (section[offset] << 8) | section[offset + 1];
    const pid = ((section[offset + 2] & 0x1f) << 8) | section[offset + 3];
    offset += 4;
    if (programNumber !== 0) return pid;
  }
  return null;
}

type PmtStreams = {
  videoPid: number | null;
  audioPid: number | null;
  videoStreamType: number | null;
  audioStreamType: number | null;
};

function parsePmtForStreams(section: Uint8Array): PmtStreams | null {
  if (section.length < 12) return null;
  if (section[0] !== 0x02) return null;
  const total = tryParseSectionTotalLength(section);
  if (!total || section.length < total) return null;

  // Program info length is at bytes 10-11
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
  let offset = 12 + programInfoLength;
  const end = total - 4; // CRC

  let videoPid: number | null = null;
  let videoStreamType: number | null = null;
  let audioPid: number | null = null;
  let audioStreamType: number | null = null;
  let audioMp3Pid: number | null = null;
  let audioMp3StreamType: number | null = null;

  while (offset + 5 <= end) {
    const streamType = section[offset];
    const pid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2];
    const esInfoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
    offset += 5 + esInfoLength;

    // Video types: H.264(0x1B), HEVC(0x24)
    if (videoPid === null && (streamType === 0x1b || streamType === 0x24)) {
      videoPid = pid;
      videoStreamType = streamType;
      continue;
    }

    // Audio types: AAC(0x0F), MPEG-1/2 Audio (0x03/0x04)
    if (streamType === 0x0f && audioPid === null) {
      audioPid = pid;
      audioStreamType = streamType;
      continue;
    }

    if ((streamType === 0x03 || streamType === 0x04) && audioMp3Pid === null) {
      audioMp3Pid = pid;
      audioMp3StreamType = streamType;
      continue;
    }
  }

  if (audioPid === null && audioMp3Pid !== null) {
    audioPid = audioMp3Pid;
    audioStreamType = audioMp3StreamType;
  }

  return { videoPid, audioPid, videoStreamType, audioStreamType };
}

function parsePesHeader(payload: Uint8Array): { pts90k: number | null; headerLen: number } | null {
  if (payload.length < 9) return null;
  if (payload[0] !== 0x00 || payload[1] !== 0x00 || payload[2] !== 0x01) return null;
  // stream_id = payload[3]
  // pes_packet_length = payload[4..5]
  const flags = payload[7];
  const headerDataLen = payload[8];
  const headerLen = 9 + headerDataLen;
  if (headerLen > payload.length) return null;

  const ptsDtsFlags = (flags >> 6) & 0x03;
  if (ptsDtsFlags === 0x02 || ptsDtsFlags === 0x03) {
    if (payload.length < 14) return null;
    const b0 = payload[9];
    const b1 = payload[10];
    const b2 = payload[11];
    const b3 = payload[12];
    const b4 = payload[13];

    const pts =
      ((b0 >> 1) & 0x07) * 0x40000000 +
      (b1 << 22) +
      (((b2 >> 1) & 0x7f) << 15) +
      (b3 << 7) +
      ((b4 >> 1) & 0x7f);

    return { pts90k: pts, headerLen };
  }

  return { pts90k: null, headerLen };
}

function findAnnexBStartCode(data: Uint8Array, from: number): { index: number; len: number } | null {
  for (let i = from; i + 3 < data.length; i++) {
    if (data[i] !== 0x00 || data[i + 1] !== 0x00) continue;
    if (data[i + 2] === 0x01) return { index: i, len: 3 };
    if (data[i + 2] === 0x00 && data[i + 3] === 0x01) return { index: i, len: 4 };
  }
  return null;
}

function collectAnnexBNalus(data: Uint8Array): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const first = findAnnexBStartCode(data, 0);
  if (!first) return out;
  let sc: { index: number; len: number } | null = first;
  while (sc) {
    const nalStart = sc.index + sc.len;
    const next = findAnnexBStartCode(data, nalStart);
    const nalEnd = next ? next.index : data.length;
    if (nalEnd > nalStart) out.push({ start: nalStart, end: nalEnd });
    sc = next;
  }
  return out;
}

function annexBToAvcc(data: Uint8Array): Uint8Array {
  const nalus = collectAnnexBNalus(data);
  if (nalus.length === 0) return new Uint8Array();
  let total = 0;
  for (const n of nalus) total += 4 + (n.end - n.start);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const n of nalus) {
    const len = n.end - n.start;
    out[offset] = (len >>> 24) & 0xff;
    out[offset + 1] = (len >>> 16) & 0xff;
    out[offset + 2] = (len >>> 8) & 0xff;
    out[offset + 3] = len & 0xff;
    out.set(data.subarray(n.start, n.end), offset + 4);
    offset += 4 + len;
  }
  return out;
}

function extractH264ParameterSets(annexB: Uint8Array): { sps: Uint8Array | null; pps: Uint8Array | null } {
  const nalus = collectAnnexBNalus(annexB);
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  for (const n of nalus) {
    const nalu = annexB.subarray(n.start, n.end);
    const nalType = nalu[0] & 0x1f;
    if (nalType === 7 && !sps) sps = new Uint8Array(nalu);
    else if (nalType === 8 && !pps) pps = new Uint8Array(nalu);
    if (sps && pps) break;
  }
  return { sps, pps };
}

function isH264KeyframeAnnexB(annexB: Uint8Array): boolean {
  const nalus = collectAnnexBNalus(annexB);
  for (const n of nalus) {
    const nalu = annexB.subarray(n.start, n.end);
    const nalType = nalu[0] & 0x1f;
    if (nalType === 5) return true;
  }
  return false;
}

function buildAvcCFromSpsPps(sps: Uint8Array, pps: Uint8Array): { codec: string; avcC: Uint8Array } {
  if (sps.length < 4) throw new Error('Invalid SPS');
  const profile = sps[1];
  const compat = sps[2];
  const level = sps[3];
  const codec = `avc1.${hex2(profile)}${hex2(compat)}${hex2(level)}`;

  const avcC = new Uint8Array(
    6 + 2 + sps.length + 1 + 2 + pps.length,
  );
  let o = 0;
  avcC[o++] = 0x01;
  avcC[o++] = profile;
  avcC[o++] = compat;
  avcC[o++] = level;
  avcC[o++] = 0xff; // lengthSizeMinusOne = 3 (4 bytes)
  avcC[o++] = 0xe1; // numOfSequenceParameterSets = 1
  avcC[o++] = (sps.length >>> 8) & 0xff;
  avcC[o++] = sps.length & 0xff;
  avcC.set(sps, o);
  o += sps.length;
  avcC[o++] = 0x01; // numOfPictureParameterSets = 1
  avcC[o++] = (pps.length >>> 8) & 0xff;
  avcC[o++] = pps.length & 0xff;
  avcC.set(pps, o);
  return { codec, avcC };
}

type AdtsInfo = {
  headerLen: number;
  frameLen: number;
  sampleRate: number;
  channelCount: number;
  audioObjectType: number;
  samplingIndex: number;
};

function parseAdtsHeader(data: Uint8Array, offset: number): AdtsInfo | null {
  if (offset + 7 > data.length) return null;
  if (data[offset] !== 0xff || (data[offset + 1] & 0xf0) !== 0xf0) return null;
  const protectionAbsent = (data[offset + 1] & 0x01) !== 0;
  const profile = (data[offset + 2] >> 6) & 0x03;
  const samplingIndex = (data[offset + 2] >> 2) & 0x0f;
  const sampleRate = AAC_SAMPLE_RATES[samplingIndex] ?? 0;
  const channelConfig = ((data[offset + 2] & 0x01) << 2) | ((data[offset + 3] >> 6) & 0x03);
  const frameLen =
    ((data[offset + 3] & 0x03) << 11) | (data[offset + 4] << 3) | ((data[offset + 5] >> 5) & 0x07);
  const headerLen = protectionAbsent ? 7 : 9;
  const audioObjectType = profile + 1;
  if (sampleRate <= 0 || channelConfig <= 0 || frameLen < headerLen) return null;
  return {
    headerLen,
    frameLen,
    sampleRate,
    channelCount: channelConfig,
    audioObjectType,
    samplingIndex,
  };
}

function buildAacAudioSpecificConfig(audioObjectType: number, samplingIndex: number, channelCount: number): Uint8Array {
  const aot = audioObjectType & 0x1f;
  const sfi = samplingIndex & 0x0f;
  const cc = channelCount & 0x0f;
  const b0 = (aot << 3) | (sfi >> 1);
  const b1 = ((sfi & 0x01) << 7) | (cc << 3);
  return new Uint8Array([b0, b1]);
}

const MP3_BITRATES_MPEG1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MP3_BITRATES_MPEG2_L3 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

const MP3_SAMPLE_RATES_MPEG1 = [44100, 48000, 32000];
const MP3_SAMPLE_RATES_MPEG2 = [22050, 24000, 16000];
const MP3_SAMPLE_RATES_MPEG25 = [11025, 12000, 8000];

type Mp3Info = {
  frameLen: number;
  sampleRate: number;
  channelCount: number;
  samplesPerFrame: number;
};

function parseMp3FrameHeader(data: Uint8Array, offset: number): Mp3Info | null {
  if (offset + 4 > data.length) return null;
  const b0 = data[offset];
  const b1 = data[offset + 1];
  const b2 = data[offset + 2];
  const b3 = data[offset + 3];

  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionId = (b1 >> 3) & 0x03;
  const layer = (b1 >> 1) & 0x03;
  if (versionId === 0x01) return null; // reserved
  if (layer !== 0x01) return null; // only Layer III supported

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padding = (b2 >> 1) & 0x01;
  if (sampleRateIndex === 0x03) return null;

  const isMpeg1 = versionId === 0x03;
  const isMpeg2 = versionId === 0x02;
  const sampleRates = isMpeg1 ? MP3_SAMPLE_RATES_MPEG1 : isMpeg2 ? MP3_SAMPLE_RATES_MPEG2 : MP3_SAMPLE_RATES_MPEG25;
  const sampleRate = sampleRates[sampleRateIndex] ?? 0;
  if (sampleRate <= 0) return null;

  const bitrateKbps = (isMpeg1 ? MP3_BITRATES_MPEG1_L3 : MP3_BITRATES_MPEG2_L3)[bitrateIndex] ?? 0;
  if (bitrateKbps <= 0) return null;

  const channelMode = (b3 >> 6) & 0x03;
  const channelCount = channelMode === 0x03 ? 1 : 2;

  const samplesPerFrame = isMpeg1 ? 1152 : 576;
  const coef = isMpeg1 ? 144 : 72;
  const frameLen = Math.floor((coef * bitrateKbps * 1000) / sampleRate) + padding;
  if (frameLen <= 4) return null;

  return { frameLen, sampleRate, channelCount, samplesPerFrame };
}

export class TSDemuxer {
  private file: ByteSource | null = null;
  private stopped = false;
  private paused = false;
  private extracting = false;
  private resumeWaiters: Array<() => void> = [];
  private startScheduled = false;

  private syncOffset = 0;
  private packetStride = TS_PACKET_SIZE;

  private pmtPid: number | null = null;
  private videoPid: number | null = null;
  private audioPid: number | null = null;
  private videoStreamType: number | null = null;
  private audioStreamType: number | null = null;

  private videoTrack: TsVideoTrackInfo | null = null;
  private audioTrack: TsAudioTrackInfo | null = null;
  private trackParsePromise: Promise<void> | null = null;

  private extractVideoPid: number | null = null;
  private extractAudioPid: number | null = null;

  private onVideoChunk: ((chunk: EncodedVideoChunk) => void) | null = null;
  private onVideoEnd: (() => void) | null = null;
  private onAudioChunk: ((chunk: EncodedAudioChunk) => void) | null = null;
  private onAudioEnd: (() => void) | null = null;

  private extractPromise: Promise<void> | null = null;

  async open(file: ByteSource) {
    this.stop();
    this.stopped = false;
    this.file = file;
    this.syncOffset = 0;
    this.packetStride = TS_PACKET_SIZE;
    this.pmtPid = null;
    this.videoPid = null;
    this.audioPid = null;
    this.videoStreamType = null;
    this.audioStreamType = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.trackParsePromise = null;
  }

  async getPrimaryVideoTrack(): Promise<TsVideoTrackInfo> {
    await this.ensureTracksParsed();
    if (!this.videoTrack) throw new Error('No video track found in TS');
    return this.videoTrack;
  }

  async getPrimaryAudioTrack(): Promise<TsAudioTrackInfo> {
    await this.ensureTracksParsed();
    if (!this.audioTrack) throw new Error('No audio track found in TS');
    return this.audioTrack;
  }

  startVideoExtraction(
    track: TsVideoTrackInfo,
    onChunk: (chunk: EncodedVideoChunk) => void,
    onEnd: () => void,
  ) {
    this.onVideoChunk = onChunk;
    this.onVideoEnd = onEnd;
    this.extractVideoPid = track.pid;
    this.extracting = true;
    this.scheduleExtractLoopStart();
  }

  startAudioExtraction(
    track: TsAudioTrackInfo,
    onChunk: (chunk: EncodedAudioChunk) => void,
    onEnd: () => void,
  ) {
    this.onAudioChunk = onChunk;
    this.onAudioEnd = onEnd;
    this.extractAudioPid = track.pid;
    this.extracting = true;
    this.scheduleExtractLoopStart();
  }

  stop() {
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
    this.extractVideoPid = null;
    this.extractAudioPid = null;
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

  private async ensureTracksParsed() {
    if (this.videoTrack && (this.audioTrack || this.audioPid === null)) return;
    if (this.trackParsePromise) return this.trackParsePromise;
    this.trackParsePromise = this.parseTracksAndConfigs();
    return this.trackParsePromise;
  }

  private async parseTracksAndConfigs() {
    const file = this.file;
    if (!file) throw new Error('Demuxer not opened');

    const probeSize = Math.min(file.size, 204 * 50);
    const head = new Uint8Array(await file.slice(0, probeSize).arrayBuffer());
    const detected = detectTsPacketStrideAndSyncOffset(head);
    if (!detected) throw new Error('Invalid TS: sync byte not found');
    this.packetStride = detected.stride;
    this.syncOffset = detected.syncOffset;

    const psiAssemblies = new Map<number, PsiAssembly>();
    const pes = new Map<number, PesAssembly>();

    let offset = 0;
    const chunkSize = 1024 * 1024;

    let foundVideo = false;
    let foundAudio = false;

    let carry = new Uint8Array();
    let droppedLeading = false;

    while (offset < file.size && !this.stopped) {
      const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
      const buf = new Uint8Array(await slice.arrayBuffer());
      offset += buf.length;

      let combined: Uint8Array;
      if (carry.length > 0) {
        combined = new Uint8Array(carry.length + buf.length);
        combined.set(carry, 0);
        combined.set(buf, carry.length);
      } else {
        combined = buf;
      }

      if (!droppedLeading) {
        if (combined.length <= this.syncOffset) {
          carry = combined.slice(0);
          continue;
        }
        combined = combined.subarray(this.syncOffset);
        droppedLeading = true;
      }

      const stride = this.packetStride;
      const packetCount = Math.floor(combined.length / stride);
      for (let pi = 0; pi < packetCount; pi++) {
        const start = pi * stride;
        if (start + TS_PACKET_SIZE > combined.length) break;
        const pkt = combined.subarray(start, start + TS_PACKET_SIZE);
        const parsed = parseTsPayload(pkt);
        if (!parsed) continue;
        const { payloadUnitStart, pid, payload } = parsed;

        if (pid === 0 || (this.pmtPid !== null && pid === this.pmtPid)) {
          const asm = psiAssemblies.get(pid) ?? { data: new Uint8Array(), totalLength: null };
          if (payloadUnitStart) {
            const sectionStart = parsePsiSection(payload);
            if (!sectionStart) continue;
            const startLen = tryParseSectionTotalLength(sectionStart);
            if (!startLen) continue;
            asm.data = sectionStart;
            asm.totalLength = startLen;
          } else if (asm.totalLength !== null) {
            const combined = new Uint8Array(asm.data.length + payload.length);
            combined.set(asm.data, 0);
            combined.set(payload, asm.data.length);
            asm.data = combined;
          } else {
            continue;
          }
          psiAssemblies.set(pid, asm);

          if (asm.totalLength !== null && asm.data.length >= asm.totalLength) {
            const section = asm.data.subarray(0, asm.totalLength);
            psiAssemblies.delete(pid);
            if (pid === 0) {
              const pmtPid = parsePatForPmtPid(section);
              if (typeof pmtPid === 'number') this.pmtPid = pmtPid;
            } else if (pid === this.pmtPid) {
              const streams = parsePmtForStreams(section);
              if (streams) {
                this.videoPid = streams.videoPid;
                this.audioPid = streams.audioPid;
                this.videoStreamType = streams.videoStreamType;
                this.audioStreamType = streams.audioStreamType;
              }
            }
          }
          continue;
        }

        if (this.videoPid === null && this.audioPid === null) continue;
        if (pid !== this.videoPid && pid !== this.audioPid) continue;

        if (payloadUnitStart) {
          // Finalize previous PES for this PID if present.
          const prev = pes.get(pid);
          if (prev && prev.length > 0) {
            const bytes = concatChunks(prev.chunks, prev.length);
            if (pid === this.videoPid && !foundVideo) {
              const { sps, pps } = extractH264ParameterSets(bytes);
              if (sps && pps) {
                const { codec, avcC } = buildAvcCFromSpsPps(sps, pps);
                this.videoTrack = {
                  pid,
                  codec,
                  width: 0,
                  height: 0,
                  description: avcC.buffer as ArrayBuffer,
                };
                foundVideo = true;
              }
            } else if (pid === this.audioPid && !foundAudio) {
              const streamType = this.audioStreamType;
              if (streamType === 0x03 || streamType === 0x04) {
                const info = this.findFirstMp3(bytes);
                if (info) {
                  this.audioTrack = {
                    pid,
                    codec: 'mp3',
                    sampleRate: info.sampleRate,
                    channelCount: info.channelCount,
                    samplesPerFrame: info.samplesPerFrame,
                  };
                  foundAudio = true;
                }
              } else {
                const info = this.findFirstAdts(bytes);
                if (info) {
                  const asc = buildAacAudioSpecificConfig(
                    info.audioObjectType,
                    info.samplingIndex,
                    info.channelCount,
                  );
                  this.audioTrack = {
                    pid,
                    codec: `mp4a.40.${info.audioObjectType}`,
                    sampleRate: info.sampleRate,
                    channelCount: info.channelCount,
                    samplesPerFrame: 1024,
                    description: asc.buffer as ArrayBuffer,
                  };
                  foundAudio = true;
                } else {
                  const mp3 = this.findFirstMp3(bytes);
                  if (mp3) {
                    this.audioTrack = {
                      pid,
                      codec: 'mp3',
                      sampleRate: mp3.sampleRate,
                      channelCount: mp3.channelCount,
                      samplesPerFrame: mp3.samplesPerFrame,
                    };
                    foundAudio = true;
                  }
                }
              }
            }
          }

          const header = parsePesHeader(payload);
          if (!header) {
            pes.delete(pid);
            continue;
          }
          const body = payload.subarray(header.headerLen);
          pes.set(pid, {
            pts90k: header.pts90k,
            chunks: body.length > 0 ? [body] : [],
            length: body.length,
          });
        } else {
          const cur = pes.get(pid);
          if (!cur) continue;
          cur.chunks.push(payload);
          cur.length += payload.length;
        }

        if (foundVideo && (foundAudio || this.audioPid === null)) return;
      }

      const processedBytes = packetCount * stride;
      carry = processedBytes < combined.length ? combined.slice(processedBytes) : new Uint8Array();
    }
  }

  private findFirstAdts(bytes: Uint8Array): AdtsInfo | null {
    for (let i = 0; i + 7 <= bytes.length; i++) {
      if (bytes[i] !== 0xff) continue;
      const info = parseAdtsHeader(bytes, i);
      if (info) return info;
    }
    return null;
  }

  private findFirstMp3(bytes: Uint8Array): Mp3Info | null {
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes[i] !== 0xff) continue;
      const info = parseMp3FrameHeader(bytes, i);
      if (info) return info;
    }
    return null;
  }

  private async runExtractLoop() {
    const file = this.file;
    if (!file) throw new Error('Demuxer not opened');
    await this.ensureTracksParsed();

    const videoPid = this.extractVideoPid ?? this.videoPid;
    const audioPid = this.extractAudioPid ?? this.audioPid;

    if (videoPid === null && audioPid === null) throw new Error('TS has no supported streams');

    const psiAssemblies = new Map<number, PsiAssembly>();
    const pes = new Map<number, PesAssembly>();

    let offset = 0;
    const chunkSize = 1024 * 1024;

    let carry = new Uint8Array();
    let droppedLeading = false;

    let pendingVideo: { timestampUs: number; data: Uint8Array; key: boolean } | null = null;
    let audioRemainder = new Uint8Array();
    let audioNextTimestampUs: number | null = null;
    let audioFrameDurUs = 0;

    const audioTrack = this.audioTrack;
    if (audioTrack) {
      const samplesPerFrame =
        typeof audioTrack.samplesPerFrame === 'number' && Number.isFinite(audioTrack.samplesPerFrame) && audioTrack.samplesPerFrame > 0
          ? audioTrack.samplesPerFrame
          : 1024;
      audioFrameDurUs = Math.round((samplesPerFrame * 1_000_000) / audioTrack.sampleRate);
    }

    while (offset < file.size && !this.stopped) {
      await this.waitIfPaused();
      const slice = file.slice(offset, Math.min(file.size, offset + chunkSize));
      const buf = new Uint8Array(await slice.arrayBuffer());
      offset += buf.length;

      let combined: Uint8Array;
      if (carry.length > 0) {
        combined = new Uint8Array(carry.length + buf.length);
        combined.set(carry, 0);
        combined.set(buf, carry.length);
      } else {
        combined = buf;
      }

      if (!droppedLeading) {
        if (combined.length <= this.syncOffset) {
          carry = combined.slice(0);
          continue;
        }
        combined = combined.subarray(this.syncOffset);
        droppedLeading = true;
      }

      const stride = this.packetStride;
      const packetCount = Math.floor(combined.length / stride);
      for (let pi = 0; pi < packetCount; pi++) {
        if (this.stopped) break;
        if (this.paused) break;
        const start = pi * stride;
        if (start + TS_PACKET_SIZE > combined.length) break;
        const pkt = combined.subarray(start, start + TS_PACKET_SIZE);
        const parsed = parseTsPayload(pkt);
        if (!parsed) continue;
        const { payloadUnitStart, pid, payload } = parsed;

        if (pid === 0 || (this.pmtPid !== null && pid === this.pmtPid)) {
          const asm = psiAssemblies.get(pid) ?? { data: new Uint8Array(), totalLength: null };
          if (payloadUnitStart) {
            const sectionStart = parsePsiSection(payload);
            if (!sectionStart) continue;
            const startLen = tryParseSectionTotalLength(sectionStart);
            if (!startLen) continue;
            asm.data = sectionStart;
            asm.totalLength = startLen;
          } else if (asm.totalLength !== null) {
            const combined = new Uint8Array(asm.data.length + payload.length);
            combined.set(asm.data, 0);
            combined.set(payload, asm.data.length);
            asm.data = combined;
          } else {
            continue;
          }
          psiAssemblies.set(pid, asm);

          if (asm.totalLength !== null && asm.data.length >= asm.totalLength) {
            const section = asm.data.subarray(0, asm.totalLength);
            psiAssemblies.delete(pid);
            if (pid === 0) {
              const pmtPid = parsePatForPmtPid(section);
              if (typeof pmtPid === 'number') this.pmtPid = pmtPid;
            } else if (pid === this.pmtPid) {
              const streams = parsePmtForStreams(section);
              if (streams) {
                this.videoPid = streams.videoPid;
                this.audioPid = streams.audioPid;
                this.videoStreamType = streams.videoStreamType;
                this.audioStreamType = streams.audioStreamType;
              }
            }
          }
          continue;
        }

        if (pid !== videoPid && pid !== audioPid) continue;

        if (payloadUnitStart) {
          const prev = pes.get(pid);
          if (prev && prev.length > 0) {
            const bytes = concatChunks(prev.chunks, prev.length);
            const ptsUs = prev.pts90k !== null ? pts90kToUs(prev.pts90k) : null;

            if (pid === videoPid && ptsUs !== null && this.onVideoChunk) {
              const data = annexBToAvcc(bytes);
              const key = isH264KeyframeAnnexB(bytes);
              const current = { timestampUs: ptsUs, data, key };

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
              pendingVideo = current;
            }

            if (pid === audioPid && ptsUs !== null && this.onAudioChunk && audioTrack) {
              if (audioNextTimestampUs === null) audioNextTimestampUs = ptsUs;
              else if (Math.abs(ptsUs - audioNextTimestampUs) > 500_000) audioNextTimestampUs = ptsUs;

              const combined = new Uint8Array(audioRemainder.length + bytes.length);
              combined.set(audioRemainder, 0);
              combined.set(bytes, audioRemainder.length);

              let pos = 0;
              if (audioTrack.codec === 'mp3') {
                while (pos + 4 <= combined.length) {
                  const info = parseMp3FrameHeader(combined, pos);
                  if (!info) {
                    pos += 1;
                    continue;
                  }
                  if (pos + info.frameLen > combined.length) break;
                  const frame = combined.subarray(pos, pos + info.frameLen);
                  const durUs = Math.round((info.samplesPerFrame * 1_000_000) / audioTrack.sampleRate);
                  this.onAudioChunk(
                    new EncodedAudioChunk({
                      type: 'key',
                      timestamp: audioNextTimestampUs,
                      duration: durUs,
                      data: frame,
                    }),
                  );
                  audioNextTimestampUs += durUs;
                  pos += info.frameLen;
                }
              } else {
                while (pos + 7 <= combined.length) {
                  const info = parseAdtsHeader(combined, pos);
                  if (!info) {
                    pos += 1;
                    continue;
                  }
                  if (pos + info.frameLen > combined.length) break;
                  const frame = combined.subarray(pos + info.headerLen, pos + info.frameLen);
                  this.onAudioChunk(
                    new EncodedAudioChunk({
                      type: 'key',
                      timestamp: audioNextTimestampUs,
                      duration: audioFrameDurUs,
                      data: frame,
                    }),
                  );
                  audioNextTimestampUs += audioFrameDurUs;
                  pos += info.frameLen;
                }
              }
              audioRemainder = combined.slice(pos);
            }
          }

          const header = parsePesHeader(payload);
          if (!header) {
            pes.delete(pid);
            continue;
          }
          const body = payload.subarray(header.headerLen);
          pes.set(pid, {
            pts90k: header.pts90k,
            chunks: body.length > 0 ? [body] : [],
            length: body.length,
          });
        } else {
          const cur = pes.get(pid);
          if (!cur) continue;
          cur.chunks.push(payload);
          cur.length += payload.length;
        }
      }

      const processedBytes = packetCount * stride;
      carry = processedBytes < combined.length ? combined.slice(processedBytes) : new Uint8Array();
    }

    // Flush pending PES for selected PIDs.
    for (const [pid, asm] of pes.entries()) {
      if (this.stopped) break;
      if (asm.length === 0) continue;
      if (pid !== videoPid && pid !== audioPid) continue;
      const bytes = concatChunks(asm.chunks, asm.length);
      const ptsUs = asm.pts90k !== null ? pts90kToUs(asm.pts90k) : null;

      if (pid === videoPid && ptsUs !== null && this.onVideoChunk) {
        const data = annexBToAvcc(bytes);
        const key = isH264KeyframeAnnexB(bytes);
        const current = { timestampUs: ptsUs, data, key };
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
        pendingVideo = current;
      }

      if (pid === audioPid && ptsUs !== null && this.onAudioChunk && audioTrack) {
        if (audioNextTimestampUs === null) audioNextTimestampUs = ptsUs;
        else if (Math.abs(ptsUs - audioNextTimestampUs) > 500_000) audioNextTimestampUs = ptsUs;

        const combined = new Uint8Array(audioRemainder.length + bytes.length);
        combined.set(audioRemainder, 0);
        combined.set(bytes, audioRemainder.length);

        let pos = 0;
        if (audioTrack.codec === 'mp3') {
          while (pos + 4 <= combined.length) {
            const info = parseMp3FrameHeader(combined, pos);
            if (!info) {
              pos += 1;
              continue;
            }
            if (pos + info.frameLen > combined.length) break;
            const frame = combined.subarray(pos, pos + info.frameLen);
            const durUs = Math.round((info.samplesPerFrame * 1_000_000) / audioTrack.sampleRate);
            this.onAudioChunk(
              new EncodedAudioChunk({
                type: 'key',
                timestamp: audioNextTimestampUs,
                duration: durUs,
                data: frame,
              }),
            );
            audioNextTimestampUs += durUs;
            pos += info.frameLen;
          }
        } else {
          while (pos + 7 <= combined.length) {
            const info = parseAdtsHeader(combined, pos);
            if (!info) {
              pos += 1;
              continue;
            }
            if (pos + info.frameLen > combined.length) break;
            const frame = combined.subarray(pos + info.headerLen, pos + info.frameLen);
            this.onAudioChunk(
              new EncodedAudioChunk({
                type: 'key',
                timestamp: audioNextTimestampUs,
                duration: audioFrameDurUs,
                data: frame,
              }),
            );
            audioNextTimestampUs += audioFrameDurUs;
            pos += info.frameLen;
          }
        }
        audioRemainder = combined.slice(pos);
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
  }
}
