import Player from './components/Player';

export default function App() {
  return (
    <div class="min-h-screen bg-slate-950 text-slate-100">
      <header class="border-b border-slate-800">
        <div class="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div class="text-lg font-semibold tracking-tight">WebPlayer</div>
          <div class="text-xs text-slate-400">
            WebGPU + WebCodecs (MP4) baseline
          </div>
        </div>
      </header>
      <main class="mx-auto max-w-5xl px-4 py-4">
        <Player />
      </main>
    </div>
  );
}

