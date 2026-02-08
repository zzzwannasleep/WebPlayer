import type { JSX } from 'solid-js';

type EmbeddedTrack = { id: string; label: string };

export interface SubtitleSelectorProps {
  disabled?: boolean;
  loadedName?: string | null;
  onLoadFile?: (file: File) => void | Promise<void>;
  onClear?: () => void;
  embeddedTracks?: EmbeddedTrack[];
  embeddedSelectedId?: string | null;
  onSelectEmbedded?: (id: string | null) => void;
}

export default function SubtitleSelector(props: SubtitleSelectorProps): JSX.Element {
  return (
    <div class="flex flex-wrap items-center gap-3 text-sm text-slate-300">
      <label class="flex items-center gap-2">
        <span>Subtitles</span>
        <input
          class="text-sm"
          type="file"
          accept=".ass,.ssa,.sup,text/plain"
          disabled={props.disabled}
          onChange={(e) => {
            const file = e.currentTarget.files?.[0] ?? null;
            e.currentTarget.value = '';
            if (!file) return;
            props.onLoadFile?.(file);
          }}
        />
      </label>

      {props.embeddedTracks && props.embeddedTracks.length > 0 && (
        <label class="flex items-center gap-2">
          <span>Embedded</span>
          <select
            class="rounded bg-slate-900 px-2 py-1 text-sm text-slate-200"
            disabled={props.disabled}
            value={props.embeddedSelectedId ?? ''}
            onChange={(e) => {
              const v = e.currentTarget.value;
              props.onSelectEmbedded?.(v ? v : null);
            }}
          >
            <option value="">Off</option>
            {props.embeddedTracks.map((t) => (
              <option value={t.id}>{t.label}</option>
            ))}
          </select>
        </label>
      )}

      {props.loadedName && (
        <span class="max-w-[40ch] truncate text-slate-400" title={props.loadedName}>
          {props.loadedName}
        </span>
      )}
      <button
        class="rounded bg-slate-800 px-2 py-1 text-xs hover:bg-slate-700 disabled:opacity-50"
        disabled={props.disabled || !props.loadedName}
        onClick={() => props.onClear?.()}
      >
        Clear
      </button>
    </div>
  );
}
