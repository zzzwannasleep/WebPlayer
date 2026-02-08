import MP4Box from 'mp4box.js';

export interface Mp4VideoTrackInfo {
  id: number;
  codec: string;
  timescale: number;
  width: number;
  height: number;
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

function pickBufferSource(value: unknown): BufferSource | undefined {
  if (!value) return undefined;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value;
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

export class MP4Demuxer {
  private mp4boxFile: any | null = null;
  private readyPromise: Promise<any> | null = null;
  private stopped = false;
  private extracting = false;
  private paused = false;

  constructor(private readonly chunkSize = 1024 * 1024) {}

  async open(file: File) {
    this.stop();
    this.stopped = false;

    const mp4boxFile = MP4Box.createFile();
    this.mp4boxFile = mp4boxFile;

    this.readyPromise = new Promise((resolve, reject) => {
      mp4boxFile.onReady = (info: any) => resolve(info);
      mp4boxFile.onError = (e: any) => reject(e instanceof Error ? e : new Error(String(e)));
    });

    let offset = 0;
    while (offset < file.size && !this.stopped) {
      const slice = file.slice(offset, offset + this.chunkSize);
      const buffer = await slice.arrayBuffer();
      (buffer as any).fileStart = offset;
      offset += buffer.byteLength;
      mp4boxFile.appendBuffer(buffer);
    }

    if (!this.stopped) mp4boxFile.flush();
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

  startVideoExtraction(
    track: Mp4VideoTrackInfo,
    onChunk: (chunk: EncodedVideoChunk) => void,
    onEnd: () => void,
  ) {
    if (!this.mp4boxFile) throw new Error('Demuxer not opened');
    const mp4boxFile = this.mp4boxFile;

    let extracted = 0;
    let ended = false;
    const maybeEnd = () => {
      if (ended) return;
      if (track.sampleCount > 0 && extracted < track.sampleCount) return;
      ended = true;
      onEnd();
    };

    this.extracting = true;
    this.paused = false;

    mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: 1 });
    mp4boxFile.onSamples = (_id: number, _user: any, samples: Mp4Sample[]) => {
      if (this.stopped) return;
      extracted += samples.length;
      for (const sample of samples) {
        const chunk = new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp: toMicroseconds(sample.cts, track.timescale),
          duration: toMicroseconds(sample.duration, track.timescale),
          data: sample.data,
        });
        onChunk(chunk);
      }
      maybeEnd();
    };
    mp4boxFile.start();
  }

  stop() {
    this.stopped = true;
    this.extracting = false;
    this.paused = false;
    try {
      this.mp4boxFile?.stop();
    } catch {
      // ignore
    }
    this.mp4boxFile = null;
    this.readyPromise = null;
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
    } catch {
      // ignore
    }
  }
}
