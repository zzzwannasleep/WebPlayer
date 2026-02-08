import { createFile } from 'mp4box';
import type { ByteSource } from '../utils/byte-source';

export interface Mp4VideoTrackInfo {
  id: number;
  codec: string;
  timescale: number;
  width: number;
  height: number;
  sampleCount: number;
  description?: BufferSource;
}

export interface Mp4AudioTrackInfo {
  id: number;
  codec: string;
  timescale: number;
  sampleRate: number;
  channelCount: number;
  sampleCount: number;
  description?: BufferSource;
}

export interface Mp4Sample {
  data: Uint8Array;
  is_sync: boolean;
  cts: number;
  duration: number;
}

function toMicroseconds(value: number, timescale: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(timescale) || timescale <= 0) return 0;
  return Math.round((value * 1_000_000) / timescale);
}

function toArrayBufferCopy(view: ArrayBufferView): ArrayBuffer {
  const u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return copy.buffer;
}

function pickBufferSource(value: unknown): BufferSource | undefined {
  if (!value) return undefined;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return toArrayBufferCopy(value);
  return undefined;
}

function tryExtractDescription(track: any): BufferSource | undefined {
  return (
    pickBufferSource(track?.description) ??
    pickBufferSource(track?.avcC) ??
    pickBufferSource(track?.hvcC) ??
    pickBufferSource(track?.vpcC) ??
    pickBufferSource(track?.av1C)
  );
}

function tryExtractAudioDescription(track: any): BufferSource | undefined {
  return (
    pickBufferSource(track?.description) ??
    pickBufferSource(track?.esds) ??
    pickBufferSource(track?.esds?.data) ??
    pickBufferSource(track?.dOps) ??
    pickBufferSource(track?.dfLa) ??
    pickBufferSource(track?.alac) ??
    pickBufferSource(track?.dac3) ??
    pickBufferSource(track?.dec3)
  );
}

type VideoExtractionTarget = {
  track: Mp4VideoTrackInfo;
  extracted: number;
  ended: boolean;
  onChunk: (chunk: EncodedVideoChunk) => void;
  onEnd: () => void;
};

type AudioExtractionTarget = {
  track: Mp4AudioTrackInfo;
  extracted: number;
  ended: boolean;
  onChunk: (chunk: EncodedAudioChunk) => void;
  onEnd: () => void;
};

export class MP4Demuxer {
  private mp4boxFile: any | null = null;
  private readyPromise: Promise<any> | null = null;
  private readPromise: Promise<void> | null = null;
  private source: ByteSource | null = null;
  private stopped = false;
  private extracting = false;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private onSamplesInstalled = false;
  private videoTargets = new Map<number, VideoExtractionTarget>();
  private audioTargets = new Map<number, AudioExtractionTarget>();
  private startScheduled = false;

  constructor(private readonly chunkSize = 1024 * 1024) {}

  async open(file: ByteSource) {
    this.stop();
    this.stopped = false;
    this.source = file;

    const mp4boxFile = createFile();
    this.mp4boxFile = mp4boxFile;

    this.readyPromise = new Promise((resolve, reject) => {
      mp4boxFile.onReady = (info: any) => resolve(info);
      mp4boxFile.onError = (e: any) => reject(e instanceof Error ? e : new Error(String(e)));
    });

    this.readPromise = this.runReadLoop(file, mp4boxFile);
    await this.readyPromise;
  }

  private async runReadLoop(file: ByteSource, mp4boxFile: any) {
    try {
      let offset = 0;
      while (offset < file.size && !this.stopped) {
        await this.waitIfPaused();
        const slice = file.slice(offset, offset + this.chunkSize);
        const buffer = await slice.arrayBuffer();
        (buffer as any).fileStart = offset;
        offset += buffer.byteLength;
        mp4boxFile.appendBuffer(buffer);
      }

      if (!this.stopped) mp4boxFile.flush();
    } catch {
      // ignore
    }
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

  async getPrimaryVideoTrack(): Promise<Mp4VideoTrackInfo> {
    if (!this.readyPromise) throw new Error('Demuxer not opened');
    const info = await this.readyPromise;
    const track = info?.videoTracks?.[0];
    if (!track) throw new Error('No video track found');

    const timescale = Number(track.timescale ?? track.track_timescale ?? info.timescale ?? 1);
    const width = Number(track.video?.width ?? track.width ?? 0);
    const height = Number(track.video?.height ?? track.height ?? 0);
    const sampleCount = Number(track.nb_samples ?? track.sample_count ?? 0);

    return {
      id: Number(track.id),
      codec: String(track.codec),
      timescale: Number.isFinite(timescale) && timescale > 0 ? timescale : 1,
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
      sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
      description: tryExtractDescription(track),
    };
  }

  async getPrimaryAudioTrack(): Promise<Mp4AudioTrackInfo> {
    if (!this.readyPromise) throw new Error('Demuxer not opened');
    const info = await this.readyPromise;
    const track = info?.audioTracks?.[0];
    if (!track) throw new Error('No audio track found');

    const timescale = Number(track.timescale ?? track.track_timescale ?? info.timescale ?? 1);
    const sampleRate = Number(track.audio?.sample_rate ?? track.sample_rate ?? track.sampleRate ?? 0);
    const channelCount = Number(
      track.audio?.channel_count ?? track.channel_count ?? track.channelCount ?? 0,
    );
    const sampleCount = Number(track.nb_samples ?? track.sample_count ?? 0);

    return {
      id: Number(track.id),
      codec: String(track.codec),
      timescale: Number.isFinite(timescale) && timescale > 0 ? timescale : 1,
      sampleRate: Number.isFinite(sampleRate) ? sampleRate : 0,
      channelCount: Number.isFinite(channelCount) ? channelCount : 0,
      sampleCount: Number.isFinite(sampleCount) ? sampleCount : 0,
      description: tryExtractAudioDescription(track),
    };
  }

  private ensureOnSamplesHandler(mp4boxFile: any) {
    if (this.onSamplesInstalled) return;
    this.onSamplesInstalled = true;

    mp4boxFile.onSamples = (id: number, _user: any, samples: Mp4Sample[]) => {
      if (this.stopped) return;
      const videoTarget = this.videoTargets.get(id);
      if (videoTarget) {
        videoTarget.extracted += samples.length;
        for (const sample of samples) {
          const chunk = new EncodedVideoChunk({
            type: sample.is_sync ? 'key' : 'delta',
            timestamp: toMicroseconds(sample.cts, videoTarget.track.timescale),
            duration: toMicroseconds(sample.duration, videoTarget.track.timescale),
            data: sample.data,
          });
          videoTarget.onChunk(chunk);
        }
        this.maybeEndVideo(videoTarget);
        return;
      }

      const audioTarget = this.audioTargets.get(id);
      if (!audioTarget) return;
      audioTarget.extracted += samples.length;
      for (const sample of samples) {
        const chunk = new EncodedAudioChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: toMicroseconds(sample.cts, audioTarget.track.timescale),
          duration: toMicroseconds(sample.duration, audioTarget.track.timescale),
          data: sample.data,
        });
        audioTarget.onChunk(chunk);
      }
      this.maybeEndAudio(audioTarget);
    };
  }

  private maybeEndVideo(target: VideoExtractionTarget) {
    if (target.ended) return;
    if (target.track.sampleCount <= 0) return;
    if (target.extracted < target.track.sampleCount) return;
    target.ended = true;
    target.onEnd();
  }

  private maybeEndAudio(target: AudioExtractionTarget) {
    if (target.ended) return;
    if (target.track.sampleCount <= 0) return;
    if (target.extracted < target.track.sampleCount) return;
    target.ended = true;
    target.onEnd();
  }

  private scheduleStart() {
    if (this.startScheduled) return;
    this.startScheduled = true;
    queueMicrotask(() => {
      this.startScheduled = false;
      if (this.stopped || this.paused || !this.extracting) return;
      try {
        this.mp4boxFile?.start();
      } catch {
        // ignore
      }
    });
  }

  startVideoExtraction(
    track: Mp4VideoTrackInfo,
    onChunk: (chunk: EncodedVideoChunk) => void,
    onEnd: () => void,
  ) {
    if (!this.mp4boxFile) throw new Error('Demuxer not opened');
    const mp4boxFile = this.mp4boxFile;

    this.extracting = true;
    this.paused = false;

    const target: VideoExtractionTarget = {
      track,
      extracted: 0,
      ended: false,
      onChunk,
      onEnd,
    };
    this.videoTargets.set(track.id, target);

    this.ensureOnSamplesHandler(mp4boxFile);
    mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: 1 });
    this.scheduleStart();
  }

  startAudioExtraction(
    track: Mp4AudioTrackInfo,
    onChunk: (chunk: EncodedAudioChunk) => void,
    onEnd: () => void,
  ) {
    if (!this.mp4boxFile) throw new Error('Demuxer not opened');
    const mp4boxFile = this.mp4boxFile;

    this.extracting = true;
    this.paused = false;

    const target: AudioExtractionTarget = {
      track,
      extracted: 0,
      ended: false,
      onChunk,
      onEnd,
    };
    this.audioTargets.set(track.id, target);

    this.ensureOnSamplesHandler(mp4boxFile);
    mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: 1 });
    this.scheduleStart();
  }

  stop() {
    this.stopped = true;
    this.extracting = false;
    this.paused = false;
    this.wakeAllResumeWaiters();
    try {
      this.source?.abort?.();
    } catch {
      // ignore
    }
    this.source = null;
    this.onSamplesInstalled = false;
    this.videoTargets.clear();
    this.audioTargets.clear();
    try {
      this.mp4boxFile?.stop();
    } catch {
      // ignore
    }
    this.mp4boxFile = null;
    this.readyPromise = null;
    this.readPromise = null;
  }

  pauseExtraction() {
    if (!this.mp4boxFile || this.stopped || !this.extracting || this.paused) return;
    try {
      this.mp4boxFile.stop();
      this.paused = true;
    } catch {
      // ignore
    }
  }

  resumeExtraction() {
    if (!this.mp4boxFile || this.stopped || !this.extracting || !this.paused) return;
    try {
      this.mp4boxFile.start();
      this.paused = false;
      this.wakeAllResumeWaiters();
    } catch {
      // ignore
    }
  }
}
