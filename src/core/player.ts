import { MediaClock } from './clock';
import { RingBuffer } from './buffer-manager';
import { audioDataToAudioBuffer } from './webaudio';
import { Canvas2DRenderer } from '../render/canvas2d-fallback';
import { WebGPURenderer } from '../render/webgpu-renderer';
import { MP4Demuxer, type Mp4AudioTrackInfo } from '../demux/mp4-demuxer';

export interface PlayerConfig {
  canvas: HTMLCanvasElement;
  container?: HTMLElement;
}

type Renderer = WebGPURenderer | Canvas2DRenderer;

export class WebPlayer {
  private canvas: HTMLCanvasElement;
  private container?: HTMLElement;
  private useWebGPU = true;
  private renderer: Renderer | null = null;
  private clock = new MediaClock();
  private clockBaseTimestampUs = 0;
  private clockBaseWallClockMs = 0;

  private pipeline: 'none' | 'video-element' | 'webcodecs-mp4' = 'none';

  private videoEl: HTMLVideoElement | null = null;
  private videoElObjectUrl: string | null = null;
  private videoFrameCallbackId = 0;

  private mp4Demuxer: MP4Demuxer | null = null;
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

  private frameQueue = new RingBuffer<VideoFrame>(8);
  private renderLoopRaf = 0;
  private clockStarted = false;
  private paused = false;

  constructor(config: PlayerConfig) {
    this.canvas = config.canvas;
    this.container = config.container;
  }

  setCanvas(canvas: HTMLCanvasElement) {
    if (this.canvas === canvas) return;
    this.canvas = canvas;
    this.renderer?.destroy();
    this.renderer = null;
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
  }

  async loadFile(file: File) {
    this.stop();
    if (!this.renderer) await this.init();

    const canUseWebCodecs =
      typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined';
    const isMp4 =
      file.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4');

    if (canUseWebCodecs && isMp4) {
      this.prewarmAudioContext();
      try {
        await this.startWebCodecsMp4Pipeline(file);
        return;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[WebPlayer] WebCodecs MP4 path failed; falling back.', e);
        this.teardownWebCodecsMp4Pipeline();
      }
    }

    await this.startVideoElementPipeline(file);
  }

  play() {
    this.paused = false;
    if (this.pipeline === 'video-element') {
      this.videoEl?.play().catch(() => {});
    }
    if (this.pipeline === 'webcodecs-mp4') {
      this.mp4Demuxer?.resumeExtraction();
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
    if (this.pipeline === 'webcodecs-mp4') {
      this.mp4Demuxer?.pauseExtraction();
      this.audioContext?.suspend().catch(() => {});
      this.clock.pause(this.wallClockMs());
      this.cancelWebCodecsRenderLoop();
      return;
    }
    this.clock.pause(this.wallClockMs());
  }

  stop() {
    this.teardownVideoElementPipeline();
    this.teardownWebCodecsMp4Pipeline();
    this.pipeline = 'none';
  }

  destroy() {
    this.stop();
    this.renderer?.destroy();
    this.renderer = null;
  }

  private async startVideoElementPipeline(file: File) {
    if (!this.renderer) throw new Error('Renderer not initialized');
    this.pipeline = 'video-element';
    this.paused = false;

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
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    attachTarget.appendChild(video);

    await video.play();
    this.clock.start(0, this.wallClockMs());

    const pump = () => {
      if (!this.videoEl || !this.renderer) return;
      this.renderer.render(this.videoEl);
      if ('requestVideoFrameCallback' in this.videoEl) {
        this.videoFrameCallbackId = (
          this.videoEl as HTMLVideoElement & {
            requestVideoFrameCallback: (
              cb: (now: number, meta: VideoFrameCallbackMetadata) => void,
            ) => number;
          }
        ).requestVideoFrameCallback(() => pump());
      } else {
        requestAnimationFrame(() => pump());
      }
    };

    pump();
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
  }

  private async startWebCodecsMp4Pipeline(file: File) {
    if (!this.renderer) throw new Error('Renderer not initialized');
    this.pipeline = 'webcodecs-mp4';
    this.paused = false;
    this.clockStarted = false;
    this.clockBaseTimestampUs = 0;
    this.clockBaseWallClockMs = 0;
    this.waitingForAudioClock = false;
    this.webcodecsStartMs = performance.now();

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

    const demuxer = new MP4Demuxer();
    await demuxer.open(file);
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

    decoder.configure(support.config);

    this.mp4Demuxer = demuxer;
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
        audioDecoder.configure(audioSupport.config);
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

    if (audioTrack) {
      demuxer.startAudioExtraction(
        audioTrack,
        (chunk) => {
          if (!this.audioDecoder) return;
          this.encodedAudioQueue.push(chunk);
          this.pumpAudioDecoder();
        },
        () => {
          this.audioDemuxEnded = true;
          this.pumpAudioDecoder(true);
        },
      );
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

    const demuxer = this.mp4Demuxer;
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
      if (this.pipeline !== 'webcodecs-mp4') return;

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

  private teardownWebCodecsMp4Pipeline() {
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

    this.mp4Demuxer?.stop();
    this.mp4Demuxer = null;

    this.teardownAudioPipeline();
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
    const demuxer = this.mp4Demuxer;
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

  private async tryGetPrimaryAudioTrack(demuxer: MP4Demuxer): Promise<Mp4AudioTrackInfo | null> {
    try {
      return await demuxer.getPrimaryAudioTrack();
    } catch {
      return null;
    }
  }
}
