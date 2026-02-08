import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import Controls from './Controls';
import SubtitleSelector from './SubtitleSelector';
import { WebPlayer } from '../core/player';

export default function Player() {
  let canvasWebGPURef: HTMLCanvasElement | undefined;
  let canvas2DRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const [useWebGPU, setUseWebGPU] = createSignal(true);
  const [status, setStatus] = createSignal<'idle' | 'ready' | 'playing' | 'paused'>(
    'idle',
  );
  const [error, setError] = createSignal<string | null>(null);

  let player: WebPlayer | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const resizeCanvasToContainer = () => {
    if (!containerRef) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = containerRef.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    for (const canvas of [canvasWebGPURef, canvas2DRef]) {
      if (!canvas) continue;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }
  };

  onMount(async () => {
    try {
      const activeCanvas = useWebGPU() ? canvasWebGPURef : canvas2DRef;
      if (!activeCanvas) throw new Error('Canvas not mounted');
      player = new WebPlayer({
        canvas: activeCanvas,
        container: containerRef,
      });
      await player.init({ useWebGPU: useWebGPU() });
      setStatus('ready');

      resizeCanvasToContainer();
      resizeObserver = new ResizeObserver(() => resizeCanvasToContainer());
      if (containerRef) resizeObserver.observe(containerRef);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  createEffect(() => {
    const enabled = useWebGPU();
    if (!player) return;
    const activeCanvas = enabled ? canvasWebGPURef : canvas2DRef;
    if (activeCanvas) player.setCanvas(activeCanvas);
    player.init({ useWebGPU: enabled }).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    player?.destroy();
    player = null;
  });

  const onChooseFile = async (file: File | null) => {
    if (!player || !file) return;
    setError(null);
    try {
      await player.loadFile(file);
      setStatus('playing');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div class="space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <label class="text-sm text-slate-300">
            <span class="mr-2">Open</span>
            <input
              class="text-sm"
              type="file"
              accept="video/*,.mp4,.mkv,.ts"
              onChange={(e) => onChooseFile(e.currentTarget.files?.[0] ?? null)}
            />
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={useWebGPU()}
              onChange={(e) => setUseWebGPU(e.currentTarget.checked)}
            />
            WebGPU
          </label>
        </div>
        <Controls
          disabled={status() === 'idle'}
          onPlay={() => {
            player?.play();
            setStatus('playing');
          }}
          onPause={() => {
            player?.pause();
            setStatus('paused');
          }}
          onStop={() => {
            player?.stop();
            setStatus('ready');
          }}
        />
      </div>

      <div class="rounded border border-slate-800 bg-black">
        <div ref={containerRef} class="relative aspect-video w-full">
          <canvas
            ref={canvasWebGPURef}
            class="absolute inset-0 h-full w-full"
            classList={{ hidden: !useWebGPU() }}
          />
          <canvas
            ref={canvas2DRef}
            class="absolute inset-0 h-full w-full"
            classList={{ hidden: useWebGPU() }}
          />
        </div>
      </div>

      <div class="flex items-center justify-between">
        <div class="text-sm text-slate-400">
          Status: <span class="text-slate-200">{status()}</span>
        </div>
        <SubtitleSelector />
      </div>

      {error() && (
        <div class="rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error()}
        </div>
      )}
    </div>
  );
}
