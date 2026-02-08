import { MediaClock } from './clock';
import { RingBuffer } from './buffer-manager';
import { audioDataToAudioBuffer } from './webaudio';
import { Canvas2DRenderer } from '../render/canvas2d-fallback';
import { WebGPURenderer } from '../render/webgpu-renderer';
import { MP4Demuxer } from '../demux/mp4-demuxer';
import { MKVDemuxer } from '../demux/mkv-demuxer';
import { TSDemuxer } from '../demux/ts-demuxer';
import type { ByteSource } from '../utils/byte-source';
import { guessNameFromUrl, openHttpByteSource } from '../utils/http-byte-source';

export interface PlayerConfig {
  canvas: HTMLCanvasElement;
  container?: HTMLElement;
}

export type InternalSubtitleTrack = {
  id: string;
  label: string;
};

export type SubtitleCue =
  | {
      kind: 'text';
      startUs: number;
      endUs: number;
      text: string;
    }
  | {
      kind: 'pgs';
      data: Uint8Array;
    };

type Renderer = WebGPURenderer | Canvas2DRenderer;

type WebCodecsPipeline = 'webcodecs-mp4' | 'webcodecs-mkv' | 'webcodecs-ts';
type Pipeline = 'none' | 'video-element' | WebCodecsPipeline;

type VideoTrackLike = {
  codec: string;
  width: number;
  height: number;
  description?: BufferSource;
};

type AudioTrackLike = {
  codec: string;
  sampleRate: number;
  channelCount: number;
  description?: BufferSource;
};

type DemuxerLike<V extends VideoTrackLike, A extends AudioTrackLike> = {
  open: (source: ByteSource) => Promise<void>;
  getPrimaryVideoTrack: () => Promise<V>;
  getPrimaryAudioTrack: () => Promise<A>;
  startVideoExtraction: (
    track: V,
    onChunk: (chunk: EncodedVideoChunk) => void,
    onEnd: () => void,
  ) => void;
  startAudioExtraction: (
    track: A,
    onChunk: (chunk: EncodedAudioChunk) => void,
    onEnd: () => void,
  ) => void;
  pauseExtraction: () => void;
  resumeExtraction: () => void;
  stop: () => void;
};

type DemuxerController = Pick<DemuxerLike<any, any>, 'pauseExtraction' | 'resumeExtraction' | 'stop'>;

type SubtitleDemuxerLike<S> = {
  getSubtitleTracks: () => Promise<S[]>;
  startSubtitleExtraction: (
    track: S,
    onCue: (cue: SubtitleCue) => void,
    onEnd: () => void,
  ) => void;
  stopSubtitleExtraction?: () => void;
};

function isSubtitleDemuxerLike<S>(demuxer: unknown): demuxer is SubtitleDemuxerLike<S> {
  const d = demuxer as any;
  return typeof d?.getSubtitleTracks === 'function' && typeof d?.startSubtitleExtraction === 'function';
}

export class WebPlayer {
  private canvas: HTMLCanvasElement;
  private container?: HTMLElement;
  private useWebGPU = true;
  private renderer: Renderer | null = null;
  private hideVideoCanvas = false;
  private clock = new MediaClock();
  private clockBaseTimestampUs = 0;
  private clockBaseWallClockMs = 0;

  private pipeline: Pipeline = 'none';

  private videoEl: HTMLVideoElement | null = null;
  private videoElObjectUrl: string | null = null;
  private videoFrameCallbackId = 0;

  private demuxer: DemuxerController | null = null;
  private demuxerInstance: unknown | null = null;
  private videoDecoder: VideoDecoder | null = null;
  private encodedQueue: EncodedVideoChunk[] = [];
  private demuxEnded = false;
  private decodeFlushPromise: Promise<void> | null = null;

  private audioContext: AudioContext | null = null;
  private audioGain: GainNode | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private encodedAudioQueue: EncodedAudioChunk[] = [];
  private audioDemuxEnded = false;
  private audioDecodeFlushPromise: Promise<void> | null = null;
  private audioScheduledUntilSec = 0;
  private audioSources = new Set<AudioBufferSourceNode>();
  private waitingForAudioClock = false;
  private webcodecsStartMs = 0;

  private internalSubtitleTracks: Array<{ id: string; label: string; track: unknown }> = [];
  private internalSubtitleSelectedId: string | null = null;
  private onSubtitleCue: ((cue: SubtitleCue) => void) | null = null;

  private frameQueue = new RingBuffer<VideoFrame>(8);
  private renderLoopRaf = 0;
  private clockStarted = false;
  private paused = false;

  constructor(config: PlayerConfig) {
    this.canvas = config.canvas;
    this.container = config.container;
  }

  private applyVideoCanvasVisibility() {
    try {
      this.canvas.style.opacity = this.hideVideoCanvas ? '0' : '1';
    } catch {
      // ignore
    }
  }

  setCanvas(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas) return;
    this.canvas = canvas;
    this.renderer?.destroy();
    this.renderer = null;
    this.applyVideoCanvasVisibility();
  }

  setContainer(container?: HTMLElement) {
    this.container = container;
  }

  async init(options?: { useWebGPU?: boolean }) {
    if (typeof options?.useWebGPU === 'boolean') this.useWebGPU = options.useWebGPU;
    this.renderer?.destroy();
    if (this.useWebGPU && navigator.gpu) {
      this.renderer = new WebGPURenderer();
    } else {
      this.renderer = new Canvas2DRenderer();
    }
    await this.renderer.init(this.canvas);
    this.applyVideoCanvasVisibility();
  }

  async loadFile(file: File) {
    this.stop();
    if (!this.renderer) await this.init();
    this.resetInternalSubtitles();

    const canUseWebCodecs =
      typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
    const name = file.name.toLowerCase();
    const isMp4 = file.type === 'video/mp4' || name.endsWith('.mp4');
    const isMkv =
      file.type === 'video/x-matroska' || file.type === 'video/webm' || name.endsWith('.mkv');
    const isTs =
      file.type === 'video/mp2t' || name.endsWith('.ts') || name.endsWith('.m2ts');

    if (canUseWebCodecs && (isMp4 || isMkv || isTs)) {
      this.prewarmAudioContext();
      try {
        if (isMp4) await this.startWebCodecsMp4Pipeline(file);
        else if (isMkv) await this.startWebCodecsMkvPipeline(file);
        else await this.startWebCodecsTsPipeline(file);
        return;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[WebPlayer] WebCodecs demux path failed; falling back.', e);
        this.teardownWebCodecsPipeline();
      }
    }

    await this.startVideoElementPipeline(file);
  }

  async loadUrl(url: string, options?: { originalUrl?: string }) {
    this.stop();
    if (!this.renderer) await this.init();
    this.resetInternalSubtitles();

    const canUseWebCodecs =
      typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';

    const originalUrl = options?.originalUrl ?? url;
    const cleaned = originalUrl.split('#')[0]?.split('?')[0] ?? originalUrl;
    const lower = cleaned.toLowerCase();
    const isMp4 = lower.endsWith('.mp4');
    const isWebm = lower.endsWith('.webm');
    const isMkv = lower.endsWith('.mkv') || isWebm;
    const isTs = lower.endsWith('.ts') || lower.endsWith('.m2ts') || lower.endsWith('.m2t');

    if (canUseWebCodecs && (isMp4 || isMkv || isTs)) {
      this.prewarmAudioContext();
      try {
        const source = await openHttpByteSource(url, { name: guessNameFromUrl(originalUrl) });
        if (isMp4) await this.startWebCodecsDemuxerPipeline(source, new MP4Demuxer(), 'webcodecs-mp4');
        else if (isMkv) await this.startWebCodecsDemuxerPipeline(source, new MKVDemuxer(), 'webcodecs-mkv');
        else await this.startWebCodecsDemuxerPipeline(source, new TSDemuxer(), 'webcodecs-ts');
        return;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[WebPlayer] WebCodecs URL demux path failed; falling back.', e);
        this.teardownWebCodecsPipeline();

        if (!isMp4 && !isWebm) {
          const detail = e instanceof Error ? e.message : String(e);
          throw new Error(
            `WebCodecs 拉流失败：${detail}。\n` +
              `MKV/TS 无法使用 <video> 回退播放，请确保源站支持 CORS + Range，或通过本地反向代理转为同源后再试。`,
          );
        }
      }
    }

    await this.startVideoElementUrlPipeline(url);
  }

  setSubtitleCueHandler(handler: ((cue: SubtitleCue) => void) | null) {
    this.onSubtitleCue = handler;
  }

  getInternalSubtitleTracks(): InternalSubtitleTrack[] {
    return this.internalSubtitleTracks.map((t) => ({ id: t.id, label: t.label }));
  }

  selectInternalSubtitleTrack(id: string | null) {
    this.internalSubtitleSelectedId = id;

    const demuxer = this.demuxerInstance;
    if (!isSubtitleDemuxerLike<unknown>(demuxer)) return;

    try {
      demuxer.stopSubtitleExtraction?.();
    } catch {
      // ignore
    }

    if (!id) return;
    const handle = this.internalSubtitleTracks.find((t) => t.id === id);
    if (!handle) return;

    demuxer.startSubtitleExtraction(
      handle.track,
      (cue) => this.onSubtitleCue?.(cue),
      () => {},
    );
  }

  play() {
    this.paused = false;
    if (this.pipeline === 'video-element') {
      this.videoEl?.play().catch(() => {});
    }
    if (this.isWebCodecsPipeline()) {
      this.demuxer?.resumeExtraction();
      this.audioContext?.resume().catch(() => {});
      this.clock.resume(this.wallClockMs());
      this.ensureWebCodecsRenderLoop();
      this.pumpWebCodecsDecoder(this.demuxEnded);
      this.pumpAudioDecoder(this.audioDemuxEnded);
      return;
    }
    this.clock.resume(this.wallClockMs());
  }

  pause() {
    this.paused = true;
    if (this.pipeline === 'video-element') this.videoEl?.pause();
    if (this.isWebCodecsPipeline()) {
      this.demuxer?.pauseExtraction();
      this.audioContext?.suspend().catch(() => {});
      this.clock.pause(this.wallClockMs());
      this.cancelWebCodecsRenderLoop();
      return;
    }
    this.clock.pause(this.wallClockMs());
  }

  stop() {
    this.teardownVideoElementPipeline();
    this.teardownWebCodecsPipeline();
    this.pipeline = 'none';
  }

  destroy() {
    this.stop();
    this.renderer?.destroy();
    this.renderer = null;
  }

  getCurrentTimeUs(): number {
    if (this.pipeline === 'video-element') {
      const t = this.videoEl?.currentTime ?? 0;
      return Number.isFinite(t) && t > 0 ? Math.floor(t * 1_000_000) : 0;
    }
    if (this.isWebCodecsPipeline()) {
      if (!this.clockStarted) return 0;
      return this.clock.nowUs(this.wallClockMs());
    }
    return 0;
  }

  private isWebCodecsPipeline(): boolean {
    return (
      this.pipeline === 'webcodecs-mp4' ||
      this.pipeline === 'webcodecs-mkv' ||
      this.pipeline === 'webcodecs-ts'
    );
  }

  private async startVideoElementPipeline(file: File) {
    if (!this.renderer) throw new Error('Renderer not initialized');
    this.pipeline = 'video-element';
    this.paused = false;
    this.hideVideoCanvas = true;
    this.applyVideoCanvasVisibility();

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = false;
    video.controls = false;
    video.preload = 'auto';

    const objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;

    this.videoEl = video;
    this.videoElObjectUrl = objectUrl;

    const attachTarget = this.container ?? document.body;
    video.style.position = 'absolute';
    (video.style as any).inset = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.background = 'black';
    video.style.pointerEvents = 'none';
    attachTarget.insertBefore(video, attachTarget.firstChild);

    await video.play();
    this.clock.start(0, this.wallClockMs());
  }

  private async startVideoElementUrlPipeline(url: string) {
    if (!this.renderer) throw new Error('Renderer not initialized');
    this.pipeline = 'video-element';
    this.paused = false;
    this.hideVideoCanvas = true;
    this.applyVideoCanvasVisibility();

    const video = document.createElement('video');
    video.playsInline = true;
    video.muted = false;
    video.controls = false;
    video.preload = 'auto';

    video.src = url;

    this.videoEl = video;
    this.videoElObjectUrl = null;

    const attachTarget = this.container ?? document.body;
    video.style.position = 'absolute';
    (video.style as any).inset = '0';
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.background = 'black';
    video.style.pointerEvents = 'none';
    attachTarget.insertBefore(video, attachTarget.firstChild);

    await video.play();
    this.clock.start(0, this.wallClockMs());
  }

  private teardownVideoElementPipeline() {
    if (this.pipeline === 'video-element') this.pipeline = 'none';
    if (this.videoEl && 'cancelVideoFrameCallback' in this.videoEl) {
      try {
        (
          this.videoEl as HTMLVideoElement & {
            cancelVideoFrameCallback: (id: number) => void;
          }
        ).cancelVideoFrameCallback(this.videoFrameCallbackId);
      } catch {
        // ignore
      }
    }
    this.videoFrameCallbackId = 0;

    if (this.videoEl) {
      try {
        this.videoEl.pause();
      } catch {
        // ignore
      }
      try {
        this.videoEl.remove();
      } catch {
        // ignore
      }
    }
    this.videoEl = null;

    if (this.videoElObjectUrl) URL.revokeObjectURL(this.videoElObjectUrl);
    this.videoElObjectUrl = null;
    this.resetInternalSubtitles();
    this.hideVideoCanvas = false;
    this.applyVideoCanvasVisibility();
  }

  private async startWebCodecsMp4Pipeline(file: File) {
    await this.startWebCodecsDemuxerPipeline(file, new MP4Demuxer(), 'webcodecs-mp4');
  }

  private async startWebCodecsMkvPipeline(file: File) {
    await this.startWebCodecsDemuxerPipeline(file, new MKVDemuxer(), 'webcodecs-mkv');
  }

  private async startWebCodecsTsPipeline(file: File) {
    await this.startWebCodecsDemuxerPipeline(file, new TSDemuxer(), 'webcodecs-ts');
  }

  private async startWebCodecsDemuxerPipeline<
    V extends VideoTrackLike,
    A extends AudioTrackLike,
  >(file: ByteSource, demuxer: DemuxerLike<V, A>, pipeline: WebCodecsPipeline) {
    if (!this.renderer) throw new Error('Renderer not initialized');
    this.pipeline = pipeline;
    this.paused = false;
    this.hideVideoCanvas = false;
    this.applyVideoCanvasVisibility();
    this.clockStarted = false;
    this.clockBaseTimestampUs = 0;
    this.clockBaseWallClockMs = 0;
    this.waitingForAudioClock = false;
    this.webcodecsStartMs = performance.now();

    this.resetInternalSubtitles();

    this.encodedQueue = [];
    this.demuxEnded = false;
    this.decodeFlushPromise = null;
    this.frameQueue.clear();
    this.encodedAudioQueue = [];
    this.audioDemuxEnded = false;
    this.audioDecodeFlushPromise = null;
    this.audioScheduledUntilSec = 0;
    for (const source of this.audioSources) {
      try {
        source.stop();
      } catch {
        // ignore
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    }
    this.audioSources.clear();

    await demuxer.open(file);
    this.demuxerInstance = demuxer;

    if (isSubtitleDemuxerLike<any>(demuxer)) {
      try {
        const tracks = await demuxer.getSubtitleTracks();
        const handles: Array<{ id: string; label: string; track: unknown }> = [];
        for (const t of tracks) {
          const trackNo = Number((t as any)?.trackNumber);
          if (!Number.isFinite(trackNo)) continue;
          const codecId = String((t as any)?.codecId ?? 'sub');
          const name =
            typeof (t as any)?.name === 'string' && (t as any).name.trim() ? (t as any).name.trim() : '';
          const lang =
            typeof (t as any)?.language === 'string' && (t as any).language.trim()
              ? (t as any).language.trim()
              : '';
          const extra = [lang, name].filter(Boolean).join(' ');
          const label =
            [`#${trackNo}`, codecId].filter(Boolean).join(' ') + (extra ? ` (${extra})` : '');
          handles.push({ id: `mkv:${trackNo}`, label, track: t });
        }
        this.internalSubtitleTracks = handles;
      } catch {
        this.internalSubtitleTracks = [];
      }
    }

    const videoTrack = await demuxer.getPrimaryVideoTrack();
    const audioTrack = await this.tryGetPrimaryAudioTrack(demuxer);

    const decoder = new VideoDecoder({
      output: (frame) => this.onDecodedVideoFrame(frame),
      error: (err) => {
        // eslint-disable-next-line no-console
        console.error('[WebPlayer] VideoDecoder error', err);
      },
    });

    const config: VideoDecoderConfig = {
      codec: videoTrack.codec,
      codedWidth: videoTrack.width || undefined,
      codedHeight: videoTrack.height || undefined,
      description: videoTrack.description,
    };

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error(`VideoDecoder config not supported: ${videoTrack.codec}`);
    }

    decoder.configure(support.config ?? config);

    this.demuxer = demuxer;
    this.videoDecoder = decoder;

    if (audioTrack && this.canUseWebCodecsAudio()) {
      try {
        const sampleRate = audioTrack.sampleRate;
        const channelCount = audioTrack.channelCount;
        if (
          !Number.isFinite(sampleRate) ||
          sampleRate <= 0 ||
          !Number.isFinite(channelCount) ||
          channelCount <= 0
        ) {
          throw new Error('Audio track missing sampleRate/channelCount');
        }

        this.ensureAudioContext(sampleRate);

        const audioDecoder = new AudioDecoder({
          output: (data) => this.onDecodedAudioData(data),
          error: (err) => this.onAudioDecoderError(err),
        });

        const audioConfig: AudioDecoderConfig = {
          codec: audioTrack.codec,
          sampleRate,
          numberOfChannels: channelCount,
          description: audioTrack.description,
        };

        const audioSupport = await AudioDecoder.isConfigSupported(audioConfig);
        if (!audioSupport.supported) {
          throw new Error(`AudioDecoder config not supported: ${audioTrack.codec}`);
        }
        audioDecoder.configure(audioSupport.config ?? audioConfig);
        this.audioDecoder = audioDecoder;
        this.waitingForAudioClock = true;
        if (this.audioContext) this.audioScheduledUntilSec = this.audioContext.currentTime;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[WebPlayer] Audio init failed; continuing without audio.', e);
        this.teardownAudioPipeline();
        this.audioDecoder = null;
        this.waitingForAudioClock = false;
      }
    }

    if (audioTrack && this.audioDecoder) {
      demuxer.startAudioExtraction(
        audioTrack,
        (chunk) => {
          this.encodedAudioQueue.push(chunk);
          this.pumpAudioDecoder();
        },
        () => {
          this.audioDemuxEnded = true;
          this.pumpAudioDecoder(true);
        },
      );
    } else {
      this.audioDemuxEnded = true;
    }

    demuxer.startVideoExtraction(
      videoTrack,
      (chunk) => {
        this.encodedQueue.push(chunk);
        this.pumpWebCodecsDecoder();
      },
      () => {
        this.demuxEnded = true;
        this.pumpWebCodecsDecoder(true);
      },
    );

    this.audioContext?.resume().catch(() => {});
    this.ensureWebCodecsRenderLoop();
  }

  private onDecodedVideoFrame(frame: VideoFrame) {
    if (!this.clockStarted && !this.waitingForAudioClock) {
      this.startClock(frame.timestamp, this.wallClockMs());
    }

    if (!this.frameQueue.push(frame)) {
      const dropped = this.frameQueue.shift();
      dropped?.close();
      this.frameQueue.push(frame);
    }
  }

  private pumpWebCodecsDecoder(endOfStream = false) {
    const decoder = this.videoDecoder;
    if (!decoder) return;

    const maxDecodeQueue = 4;
    const maxFramesBuffered = this.frameQueue.capacity - 2;

    while (
      this.encodedQueue.length > 0 &&
      decoder.decodeQueueSize < maxDecodeQueue &&
      this.frameQueue.length < maxFramesBuffered
    ) {
      const chunk = this.encodedQueue.shift();
      if (!chunk) break;
      decoder.decode(chunk);
    }

    const demuxer = this.demuxer;
    if (demuxer) {
      this.updateDemuxerBackpressure();
    }

    if (endOfStream && this.encodedQueue.length === 0 && !this.decodeFlushPromise) {
      this.decodeFlushPromise = decoder
        .flush()
        .then(() => {})
        .catch(() => {});
    }
  }

  private ensureWebCodecsRenderLoop() {
    if (this.renderLoopRaf) return;
    const loop = () => {
      this.renderLoopRaf = requestAnimationFrame(loop);
      if (this.paused) return;
      if (!this.renderer) return;
      if (!this.isWebCodecsPipeline()) return;

      if (
        !this.clockStarted &&
        this.waitingForAudioClock &&
        performance.now() - this.webcodecsStartMs > 1000
      ) {
        const peek = this.frameQueue.peek();
        if (peek) {
          this.waitingForAudioClock = false;
          this.startClock(peek.timestamp, this.wallClockMs());
        }
      }

      if (!this.clockStarted) {
        this.pumpWebCodecsDecoder(this.demuxEnded);
        this.pumpAudioDecoder(this.audioDemuxEnded);
        return;
      }

      const nowUs = this.clock.nowUs(this.wallClockMs());
      let rendered = false;
      while (true) {
        const next = this.frameQueue.peek();
        if (!next) break;
        if (next.timestamp > nowUs) break;
        const frame = this.frameQueue.shift();
        if (!frame) break;
        this.renderer.render(frame);
        frame.close();
        rendered = true;
      }

      if (rendered) this.pumpWebCodecsDecoder(this.demuxEnded);
      this.pumpAudioDecoder(this.audioDemuxEnded);
    };
    this.renderLoopRaf = requestAnimationFrame(loop);
  }

  private cancelWebCodecsRenderLoop() {
    if (!this.renderLoopRaf) return;
    cancelAnimationFrame(this.renderLoopRaf);
    this.renderLoopRaf = 0;
  }

  private teardownWebCodecsPipeline() {
    this.cancelWebCodecsRenderLoop();

    let frame = this.frameQueue.shift();
    while (frame) {
      frame.close();
      frame = this.frameQueue.shift();
    }
    this.frameQueue.clear();
    this.encodedQueue = [];
    this.demuxEnded = false;
    this.decodeFlushPromise = null;
    this.clockStarted = false;
    this.paused = false;
    this.waitingForAudioClock = false;
    this.encodedAudioQueue = [];
    this.audioDemuxEnded = false;
    this.audioDecodeFlushPromise = null;
    this.audioScheduledUntilSec = 0;
    for (const source of this.audioSources) {
      try {
        source.stop();
      } catch {
        // ignore
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    }
    this.audioSources.clear();

    try {
      this.videoDecoder?.close();
    } catch {
      // ignore
    }
    this.videoDecoder = null;

    this.demuxer?.stop();
    this.demuxer = null;
    this.resetInternalSubtitles();
    this.demuxerInstance = null;

    this.teardownAudioPipeline();
    this.hideVideoCanvas = false;
    this.applyVideoCanvasVisibility();
  }

  private resetInternalSubtitles() {
    const demuxer = this.demuxerInstance;
    if (isSubtitleDemuxerLike<unknown>(demuxer)) {
      try {
        demuxer.stopSubtitleExtraction?.();
      } catch {
        // ignore
      }
    }
    this.internalSubtitleTracks = [];
    this.internalSubtitleSelectedId = null;
  }

  private canUseWebCodecsAudio(): boolean {
    return (
      typeof AudioDecoder !== 'undefined' &&
      typeof EncodedAudioChunk !== 'undefined' &&
      typeof AudioContext !== 'undefined'
    );
  }

  private prewarmAudioContext() {
    if (!this.canUseWebCodecsAudio()) return;
    try {
      this.ensureAudioContext();
      this.audioContext?.resume().catch(() => {});
    } catch {
      // ignore
    }
  }

  private ensureAudioContext(preferredSampleRate?: number): AudioContext {
    if (this.audioContext) return this.audioContext;
    const ctx =
      typeof preferredSampleRate === 'number'
        ? new AudioContext({ sampleRate: preferredSampleRate })
        : new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);
    this.audioContext = ctx;
    this.audioGain = gain;
    this.audioScheduledUntilSec = ctx.currentTime;
    return ctx;
  }

  private teardownAudioPipeline() {
    try {
      this.audioDecoder?.close();
    } catch {
      // ignore
    }
    this.audioDecoder = null;

    if (this.audioContext) {
      const ctx = this.audioContext;
      this.audioContext = null;
      this.audioGain = null;
      ctx.close().catch(() => {});
    } else {
      this.audioGain = null;
    }
  }

  private wallClockMs(): number {
    if (this.audioContext) return this.audioContext.currentTime * 1000;
    return performance.now();
  }

  private startClock(timestampUs: number, wallClockMs: number) {
    this.clock.start(timestampUs, wallClockMs);
    this.clockStarted = true;
    this.clockBaseTimestampUs = timestampUs;
    this.clockBaseWallClockMs = wallClockMs;
  }

  private updateDemuxerBackpressure() {
    const demuxer = this.demuxer;
    if (!demuxer) return;
    if (this.paused) {
      demuxer.pauseExtraction();
      return;
    }
    const highWater = 120;
    const lowWater = 40;
    if (
      this.encodedQueue.length >= highWater ||
      (this.audioDecoder && this.encodedAudioQueue.length >= highWater)
    ) {
      demuxer.pauseExtraction();
    } else if (
      this.encodedQueue.length <= lowWater &&
      (!this.audioDecoder || this.encodedAudioQueue.length <= lowWater)
    ) {
      demuxer.resumeExtraction();
    }
  }

  private pumpAudioDecoder(endOfStream = false) {
    const decoder = this.audioDecoder;
    if (!decoder) return;

    const ctx = this.audioContext;
    const maxBufferedSec = 2;
    if (ctx) {
      const bufferedSec = this.audioScheduledUntilSec - ctx.currentTime;
      if (bufferedSec > maxBufferedSec) {
        this.updateDemuxerBackpressure();
        return;
      }
    }

    const maxDecodeQueue = 8;
    while (
      this.encodedAudioQueue.length > 0 &&
      decoder.decodeQueueSize < maxDecodeQueue
    ) {
      const chunk = this.encodedAudioQueue.shift();
      if (!chunk) break;
      decoder.decode(chunk);
    }

    this.updateDemuxerBackpressure();

    if (
      endOfStream &&
      this.encodedAudioQueue.length === 0 &&
      !this.audioDecodeFlushPromise
    ) {
      this.audioDecodeFlushPromise = decoder
        .flush()
        .then(() => {})
        .catch(() => {});
    }
  }

  private onDecodedAudioData(data: AudioData) {
    const ctx = this.audioContext;
    const gain = this.audioGain;
    if (!ctx || !gain) {
      data.close();
      return;
    }

    try {
      if (!this.clockStarted) {
        const startDelaySec = 0.05;
        const baseTimeSec = ctx.currentTime + startDelaySec;
        this.startClock(data.timestamp, baseTimeSec * 1000);
        this.waitingForAudioClock = false;
        if (this.audioScheduledUntilSec < baseTimeSec) this.audioScheduledUntilSec = baseTimeSec;
      }

      const audioBuffer = audioDataToAudioBuffer(ctx, data);
      if (audioBuffer.length === 0) return;

      const baseTimeSec = this.clockBaseWallClockMs / 1000;
      const idealStartSec =
        baseTimeSec + (data.timestamp - this.clockBaseTimestampUs) / 1_000_000;

      const minStartSec = Math.max(ctx.currentTime, this.audioScheduledUntilSec);
      const offsetSec = Math.max(0, minStartSec - idealStartSec);
      if (offsetSec >= audioBuffer.duration) return;

      const startSec = idealStartSec + offsetSec;
      const playDurSec = audioBuffer.duration - offsetSec;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gain);
      source.onended = () => this.audioSources.delete(source);
      this.audioSources.add(source);

      try {
        if (offsetSec > 0 || playDurSec < audioBuffer.duration) {
          source.start(startSec, offsetSec, playDurSec);
        } else {
          source.start(startSec);
        }
      } catch {
        // ignore
      }

      const idealEndSec = idealStartSec + audioBuffer.duration;
      if (idealEndSec > this.audioScheduledUntilSec) this.audioScheduledUntilSec = idealEndSec;
    } finally {
      data.close();
    }

    this.pumpAudioDecoder(this.audioDemuxEnded);
  }

  private onAudioDecoderError(err: unknown) {
    // eslint-disable-next-line no-console
    console.error('[WebPlayer] AudioDecoder error', err);
    this.waitingForAudioClock = false;
    try {
      this.audioDecoder?.close();
    } catch {
      // ignore
    }
    this.audioDecoder = null;
    this.encodedAudioQueue = [];
  }

  private async tryGetPrimaryAudioTrack<A>(demuxer: { getPrimaryAudioTrack: () => Promise<A> }): Promise<A | null> {
    try {
      return await demuxer.getPrimaryAudioTrack();
    } catch {
      return null;
    }
  }
}
