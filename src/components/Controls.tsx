import type { JSX } from 'solid-js';

export interface ControlsProps {
  disabled?: boolean;
  onPlay?: () => void;
  onPause?: () => void;
  onStop?: () => void;
}

export default function Controls(props: ControlsProps): JSX.Element {
  return (
    <div class="flex items-center gap-2">
      <button
        class="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50"
        disabled={props.disabled}
        onClick={() => props.onPlay?.()}
      >
        Play
      </button>
      <button
        class="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50"
        disabled={props.disabled}
        onClick={() => props.onPause?.()}
      >
        Pause
      </button>
      <button
        class="rounded bg-slate-800 px-3 py-1 text-sm hover:bg-slate-700 disabled:opacity-50"
        disabled={props.disabled}
        onClick={() => props.onStop?.()}
      >
        Stop
      </button>
    </div>
  );
}

