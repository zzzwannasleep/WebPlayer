export interface AssCue {
  startUs: number;
  endUs: number;
  text: string;
}

const DEFAULT_EVENT_FORMAT = [
  'Layer',
  'Start',
  'End',
  'Style',
  'Name',
  'MarginL',
  'MarginR',
  'MarginV',
  'Effect',
  'Text',
];

function parseAssTimeToUs(value: string): number {
  const v = value.trim();
  const m = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?$/.exec(v);
  if (!m) return NaN;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const frac = m[4] ?? '';
  if (![hours, minutes, seconds].every((n) => Number.isFinite(n) && n >= 0)) return NaN;
  const cs = frac.length === 0 ? 0 : Number(frac.slice(0, 2).padEnd(2, '0'));
  if (!Number.isFinite(cs) || cs < 0) return NaN;
  return (hours * 3600 + minutes * 60 + seconds) * 1_000_000 + cs * 10_000;
}

export function stripAssText(text: string): string {
  return text
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .trim();
}

function splitCsvN(line: string, fields: number): string[] {
  if (fields <= 1) return [line];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < fields - 1; i++) {
    const idx = line.indexOf(',', start);
    if (idx === -1) break;
    out.push(line.slice(start, idx));
    start = idx + 1;
  }
  out.push(line.slice(start));
  return out;
}

export function parseAssEventFormatFromHeader(content: string): string[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  let section = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(';')) continue;

    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }

    if (section !== 'events') continue;
    if (!line.toLowerCase().startsWith('format:')) continue;

    const rest = line.slice('format:'.length).trim();
    const nextFormat = rest.split(',').map((s) => s.trim()).filter(Boolean);
    return nextFormat.length >= 3 ? nextFormat : DEFAULT_EVENT_FORMAT;
  }
  return DEFAULT_EVENT_FORMAT;
}

export function extractAssTextFromDialogueLine(dialogueLine: string, format?: string[]): string {
  const fmt = format && format.length > 0 ? format : DEFAULT_EVENT_FORMAT;
  const textIndex = fmt.findIndex((f) => f.toLowerCase() === 'text');
  const line = dialogueLine.trim();
  const lower = line.toLowerCase();

  // MKV often stores just the CSV fields; some files store a full `Dialogue:` line.
  const rest =
    lower.startsWith('dialogue:') || lower.startsWith('comment:')
      ? line.slice(line.indexOf(':') + 1).trimStart()
      : line;

  const parts = splitCsvN(rest, fmt.length);
  const textStr = parts[textIndex] ?? parts[parts.length - 1] ?? '';
  return stripAssText(textStr);
}

export function parseAss(content: string): AssCue[] {
  const cues: AssCue[] = [];
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  let section = '';
  let format = DEFAULT_EVENT_FORMAT;
  let startIndex = format.findIndex((f) => f.toLowerCase() === 'start');
  let endIndex = format.findIndex((f) => f.toLowerCase() === 'end');
  let textIndex = format.findIndex((f) => f.toLowerCase() === 'text');

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith(';')) continue;

    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }

    if (section !== 'events') continue;

    if (line.toLowerCase().startsWith('format:')) {
      const rest = line.slice('format:'.length).trim();
      const nextFormat = rest.split(',').map((s) => s.trim()).filter(Boolean);
      if (nextFormat.length >= 3) {
        format = nextFormat;
        startIndex = format.findIndex((f) => f.toLowerCase() === 'start');
        endIndex = format.findIndex((f) => f.toLowerCase() === 'end');
        textIndex = format.findIndex((f) => f.toLowerCase() === 'text');
      }
      continue;
    }

    if (line.toLowerCase().startsWith('dialogue:')) {
      const rest = line.slice('dialogue:'.length).trimStart();
      const parts = splitCsvN(rest, format.length);
      const startStr = parts[startIndex] ?? '';
      const endStr = parts[endIndex] ?? '';
      const textStr = parts[textIndex] ?? parts[parts.length - 1] ?? '';

      const startUs = parseAssTimeToUs(startStr);
      const endUs = parseAssTimeToUs(endStr);
      if (!Number.isFinite(startUs) || !Number.isFinite(endUs) || endUs <= startUs) continue;

      const text = stripAssText(textStr);
      if (!text) continue;

      cues.push({ startUs, endUs, text });
    }
  }

  cues.sort((a, b) => a.startUs - b.startUs);
  return cues;
}
