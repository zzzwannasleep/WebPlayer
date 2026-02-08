import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import Controls from './Controls';
import SubtitleSelector from './SubtitleSelector';
import { WebPlayer, type InternalSubtitleTrack } from '../core/player';
import { SubtitleRenderer } from '../subtitle/renderer';

export default function Player() {
  let canvasWebGPURef: HTMLCanvasElement | undefined;
  let canvas2DRef: HTMLCanvasElement | undefined;
  let subtitleCanvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const [useWebGPU, setUseWebGPU] = createSignal(true);
  const [status, setStatus] = createSignal<'idle' | 'ready' | 'playing' | 'paused'>(
    'idle',
  );
  const [error, setError] = createSignal<string | null>(null);
  const [subtitleLabel, setSubtitleLabel] = createSignal<string | null>(null);
  const [embeddedTracks, setEmbeddedTracks] = createSignal<InternalSubtitleTrack[]>([]);
  const [embeddedSelectedId, setEmbeddedSelectedId] = createSignal<string | null>(null);
  const [subtitleMode, setSubtitleMode] = createSignal<'none' | 'external' | 'embedded'>('none');
  const [urlInput, setUrlInput] = createSignal<string>('');

  let player: WebPlayer | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let subtitleRaf = 0;
  const subtitleRenderer = new SubtitleRenderer();

  const resizeCanvasToContainer = () => {
    if (!containerRef) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = containerRef.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    for (const canvas of [canvasWebGPURef, canvas2DRef, subtitleCanvasRef]) {
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
      player.setSubtitleCueHandler((cue) => {
        if (cue.kind === 'pgs') {
          subtitleRenderer
            .loadSup(cue.data)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)));
          return;
        }
        subtitleRenderer.addCue(cue);
      });
      setStatus('ready');

      resizeCanvasToContainer();
      resizeObserver = new ResizeObserver(() => resizeCanvasToContainer());
      if (containerRef) resizeObserver.observe(containerRef);

      const tickSubtitles = () => {
        subtitleRaf = requestAnimationFrame(tickSubtitles);
        if (!player) return;
        if (!subtitleCanvasRef) return;
        subtitleRenderer.renderToCanvas(player.getCurrentTimeUs(), subtitleCanvasRef);
      };
      subtitleRaf = requestAnimationFrame(tickSubtitles);
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
    if (subtitleRaf) cancelAnimationFrame(subtitleRaf);
    subtitleRaf = 0;
    resizeObserver?.disconnect();
    player?.setSubtitleCueHandler(null);
    player?.destroy();
    player = null;
  });

  const syncEmbeddedSubtitlesAfterLoad = () => {
    if (!player) return;
    const tracks = player.getInternalSubtitleTracks();
    setEmbeddedTracks(tracks);
    player.selectInternalSubtitleTrack(null);
    setEmbeddedSelectedId(null);

    if (subtitleMode() !== 'external' && tracks.length > 0) {
      const first = tracks[0];
      subtitleRenderer.clear();
      setSubtitleMode('embedded');
      setEmbeddedSelectedId(first.id);
      setSubtitleLabel(first.label);
      player.selectInternalSubtitleTrack(first.id);
    } else if (tracks.length === 0 && subtitleMode() === 'embedded') {
      subtitleRenderer.clear();
      setSubtitleMode('none');
      setSubtitleLabel(null);
    }
  };

  const onChooseFile = async (file: File | null) => {
    if (!player || !file) return;
    setError(null);
    try {
      await player.loadFile(file);
      syncEmbeddedSubtitlesAfterLoad();

      setStatus('playing');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onChooseUrl = async () => {
    if (!player) return;
    const url = urlInput().trim();
    if (!url) return;
    setError(null);
    try {
      await player.loadUrl(url);
      syncEmbeddedSubtitlesAfterLoad();

      setStatus('playing');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onLoadSubtitleFile = async (file: File) => {
    setError(null);
    try {
      subtitleRenderer.clear();
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.sup')) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await subtitleRenderer.loadSup(bytes);
      } else {
        const content = await file.text();
        subtitleRenderer.loadAss(content);
      }
      setSubtitleMode('external');
      setSubtitleLabel(file.name);
      setEmbeddedSelectedId(null);
      player?.selectInternalSubtitleTrack(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onClearSubtitles = () => {
    subtitleRenderer.clear();
    setSubtitleMode('none');
    setSubtitleLabel(null);
    setEmbeddedSelectedId(null);
    player?.selectInternalSubtitleTrack(null);
  };

  const onSelectEmbedded = (id: string | null) => {
    if (!player) return;
    subtitleRenderer.clear();

    setEmbeddedSelectedId(id);
    player.selectInternalSubtitleTrack(id);
    if (!id) {
      setSubtitleMode('none');
      setSubtitleLabel(null);
      return;
    }

    const track = embeddedTracks().find((t) => t.id === id);
    setSubtitleMode('embedded');
    setSubtitleLabel(track?.label ?? 'Embedded subtitles');
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
              accept="video/*,.mp4,.mkv,.ts,.m2ts"
              onChange={(e) => onChooseFile(e.currentTarget.files?.[0] ?? null)}
            />
          </label>
          <label class="flex items-center gap-2 text-sm text-slate-300">
            <span>URL</span>
            <input
              class="w-[36ch] rounded bg-slate-900 px-2 py-1 text-sm text-slate-200 placeholder:text-slate-500"
              type="url"
              placeholder="https://example.com/video.mp4"
              value={urlInput()}
              onInput={(e) => setUrlInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onChooseUrl();
              }}
            />
            <button
              class="rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700 disabled:opacity-50"
              disabled={!urlInput().trim()}
              onClick={() => onChooseUrl()}
            >
              Open URL
            </button>
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
          <canvas
            ref={subtitleCanvasRef}
            class="pointer-events-none absolute inset-0 h-full w-full"
          />
        </div>
      </div>

      <div class="flex items-center justify-between">
        <div class="text-sm text-slate-400">
          Status: <span class="text-slate-200">{status()}</span>
        </div>
        <SubtitleSelector
          disabled={status() === 'idle'}
          loadedName={subtitleLabel()}
          onLoadFile={onLoadSubtitleFile}
          onClear={onClearSubtitles}
          embeddedTracks={embeddedTracks()}
          embeddedSelectedId={embeddedSelectedId()}
          onSelectEmbedded={onSelectEmbedded}
        />
      </div>

      {error() && (
        <div class="rounded border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {error()}
        </div>
      )}
    </div>
  );
}
