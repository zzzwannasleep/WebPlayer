import { MediaClock } from './clock';
import { RingBuffer } from './buffer-manager';
import { Canvas2DRenderer } from '../render/canvas2d-fallback';
import { WebGPURenderer } from '../render/webgpu-renderer';
import { MP4Demuxer } from '../demux/mp4-demuxer';

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

  private pipeline: 'none' | 'video-element' | 'webcodecs-mp4' = 'none';

  private videoEl: HTMLVideoElement | null = null;
  private videoElObjectUrl: string | null = null;
  private videoFrameCallbackId = 0;

  private mp4Demuxer: MP4Demuxer | null = null;
  private videoDecoder: VideoDecoder | null = null;
  private encodedQueue: EncodedVideoChunk[] = [];
  private demuxEnded = false;
  private decodeFlushPromise: Promise<void> | null = null;
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
    this.clock.resume();
    if (this.pipeline === 'webcodecs-mp4') this.ensureWebCodecsRenderLoop();
  }

  pause() {
    this.paused = true;
    if (this.pipeline === 'video-element') this.videoEl?.pause();
    this.clock.pause();
    if (this.pipeline === 'webcodecs-mp4') this.cancelWebCodecsRenderLoop();
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
    this.clock.start(0);

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
    this.clock.pause();

    this.encodedQueue = [];
    this.demuxEnded = false;
    this.decodeFlushPromise = null;
    this.frameQueue.clear();

    const demuxer = new MP4Demuxer();
    await demuxer.open(file);
    const videoTrack = await demuxer.getPrimaryVideoTrack();

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

    this.clock.resume();
    this.ensureWebCodecsRenderLoop();
  }

  private onDecodedVideoFrame(frame: VideoFrame) {
    if (!this.clockStarted) {
      this.clock.start(frame.timestamp);
      this.clockStarted = true;
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
      const highWater = 120;
      const lowWater = 40;
      if (this.encodedQueue.length >= highWater) demuxer.pauseExtraction();
      else if (this.encodedQueue.length <= lowWater) demuxer.resumeExtraction();
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
      if (!this.clockStarted) return;

      const nowUs = this.clock.nowUs();
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

    try {
      this.videoDecoder?.close();
    } catch {
      // ignore
    }
    this.videoDecoder = null;

    this.mp4Demuxer?.stop();
    this.mp4Demuxer = null;
  }
}
