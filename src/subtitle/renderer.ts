import { compile, type CompiledASS } from 'ass-compiler';
import { parseAss, type AssCue } from './ass-parser';
import { SupDecoder, type SupCue } from './sup-decoder';

type Segment = {
  text: string;
  tag: any;
  style: any;
};

type Line = Segment[];

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function parseHexByte(hex: unknown, fallback = 0): number {
  if (typeof hex !== 'string') return fallback;
  const m = /^[0-9a-f]{2}$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[0], 16);
  return Number.isFinite(v) ? v : fallback;
}

function encodeHexByte(v: number): string {
  const n = Math.max(0, Math.min(255, Math.round(v)));
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function parseBBGGRR(hex: unknown): { r: number; g: number; b: number } {
  if (typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
  const m = /^[0-9a-f]{6}$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const s = m[0];
  const bb = parseInt(s.slice(0, 2), 16);
  const gg = parseInt(s.slice(2, 4), 16);
  const rr = parseInt(s.slice(4, 6), 16);
  return {
    r: Number.isFinite(rr) ? rr : 0,
    g: Number.isFinite(gg) ? gg : 0,
    b: Number.isFinite(bb) ? bb : 0,
  };
}

function encodeBBGGRR(rgb: { r: number; g: number; b: number }): string {
  const r = Math.max(0, Math.min(255, Math.round(rgb.r)));
  const g = Math.max(0, Math.min(255, Math.round(rgb.g)));
  const b = Math.max(0, Math.min(255, Math.round(rgb.b)));
  const rr = r.toString(16).toUpperCase().padStart(2, '0');
  const gg = g.toString(16).toUpperCase().padStart(2, '0');
  const bb = b.toString(16).toUpperCase().padStart(2, '0');
  return `${bb}${gg}${rr}`;
}

function normalizeAssText(text: string): string {
  // Newlines and hard spaces.
  return text
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ')
    .replace(/\\\\/g, '\\');
}

function computeFadeOpacity(
  fade: any,
  timeMsFromStart: number,
  durationMs: number,
): number {
  if (!fade || !Number.isFinite(timeMsFromStart) || !Number.isFinite(durationMs)) return 1;
  const t = Math.max(0, timeMsFromStart);
  const d = Math.max(0, durationMs);
  if (fade.type === 'fad') {
    const t1 = Number(fade.t1 ?? 0);
    const t2 = Number(fade.t2 ?? 0);
    let o = 1;
    if (Number.isFinite(t1) && t1 > 0 && t < t1) o = Math.min(o, t / t1);
    if (Number.isFinite(t2) && t2 > 0 && d > 0 && t > d - t2) o = Math.min(o, (d - t) / t2);
    return clamp01(o);
  }
  if (fade.type === 'fade') {
    const a1 = Number(fade.a1 ?? 0);
    const a2 = Number(fade.a2 ?? 0);
    const a3 = Number(fade.a3 ?? 0);
    const t1 = Number(fade.t1 ?? 0);
    const t2 = Number(fade.t2 ?? 0);
    const t3 = Number(fade.t3 ?? 0);
    const t4 = Number(fade.t4 ?? 0);

    const alphaAt = () => {
      if (!Number.isFinite(t1) || !Number.isFinite(t2) || !Number.isFinite(t3) || !Number.isFinite(t4)) {
        return a2;
      }
      if (t < t1) return a1;
      if (t < t2) return lerp(a1, a2, clamp01((t - t1) / Math.max(1, t2 - t1)));
      if (t < t3) return a2;
      if (t < t4) return lerp(a2, a3, clamp01((t - t3) / Math.max(1, t4 - t3)));
      return a3;
    };

    const alpha = alphaAt();
    const o = 1 - Math.max(0, Math.min(255, alpha)) / 255;
    return clamp01(o);
  }
  return 1;
}

function applyTagTransforms(baseTag: any, timeMsFromStart: number): any {
  const out: any = { ...baseTag };
  const transforms: any[] | undefined = Array.isArray(baseTag?.t) ? baseTag.t : undefined;
  delete out.t;
  if (!transforms || transforms.length === 0) return out;

  for (const tr of transforms) {
    if (!tr || typeof tr !== 'object') continue;
    const t1 = Number(tr.t1 ?? 0);
    const t2 = Number(tr.t2 ?? t1);
    const accel = Number(tr.accel ?? 1);
    const target = tr.tag ?? {};
    if (!target || typeof target !== 'object') continue;

    const pRaw = t2 !== t1 ? (timeMsFromStart - t1) / (t2 - t1) : timeMsFromStart >= t2 ? 1 : 0;
    const p = Math.pow(clamp01(pRaw), Number.isFinite(accel) && accel > 0 ? accel : 1);

    for (const key of Object.keys(target)) {
      if (key === 'clip') continue;
      const tv = (target as any)[key];
      if (tv === undefined) continue;
      const bv = out[key];

      if (key.length === 2 && key[0] === 'c' && '1234'.includes(key[1]) && typeof tv === 'string') {
        const bRgb = parseBBGGRR(typeof bv === 'string' ? bv : '000000');
        const tRgb = parseBBGGRR(tv);
        out[key] = encodeBBGGRR({
          r: lerp(bRgb.r, tRgb.r, p),
          g: lerp(bRgb.g, tRgb.g, p),
          b: lerp(bRgb.b, tRgb.b, p),
        });
        continue;
      }

      if (key.length === 2 && key[0] === 'a' && '1234'.includes(key[1]) && typeof tv === 'string') {
        const bA = parseHexByte(typeof bv === 'string' ? bv : '00', 0);
        const tA = parseHexByte(tv, bA);
        out[key] = encodeHexByte(lerp(bA, tA, p));
        continue;
      }

      if (typeof tv === 'number') {
        const bNum = typeof bv === 'number' ? bv : Number(bv);
        const from = Number.isFinite(bNum) ? bNum : tv;
        out[key] = lerp(from, tv, p);
        continue;
      }

      // Fallback: step at end.
      if (p >= 1) out[key] = tv;
    }
  }

  return out;
}

function rgbaFromAss(tag: any, colorKey: 'c1' | 'c3' | 'c4', alphaKey: 'a1' | 'a3' | 'a4', opacity = 1): string {
  const c = tag?.[colorKey];
  const a = tag?.[alphaKey];
  const rgb = parseBBGGRR(typeof c === 'string' ? c : '000000');
  const alphaByte = parseHexByte(a, 0);
  const o = clamp01((1 - alphaByte / 255) * opacity);
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${o})`;
}

function alignToAnchor(alignment: number): { ax: number; ay: number; h: 'left' | 'center' | 'right'; v: 'top' | 'middle' | 'bottom' } {
  const a = Number.isFinite(alignment) ? alignment : 2;
  const h: 'left' | 'center' | 'right' = a === 1 || a === 4 || a === 7 ? 'left' : a === 2 || a === 5 || a === 8 ? 'center' : 'right';
  const v: 'top' | 'middle' | 'bottom' = a >= 7 ? 'top' : a >= 4 ? 'middle' : 'bottom';
  const ax = h === 'left' ? 0 : h === 'center' ? 0.5 : 1;
  const ay = v === 'top' ? 0 : v === 'middle' ? 0.5 : 1;
  return { ax, ay, h, v };
}

function setFontFromTag(ctx: CanvasRenderingContext2D, tag: any) {
  const size = Number(tag?.fs ?? 20);
  const fontSize = Number.isFinite(size) && size > 0 ? size : 20;
  const fontName = typeof tag?.fn === 'string' && tag.fn.trim() ? tag.fn.trim() : 'Arial';
  const italic = tag?.i ? 'italic ' : '';
  const bold = tag?.b ? 'bold ' : '';
  ctx.font = `${italic}${bold}${fontSize}px ${fontName}`;
}

function measureRunWidth(ctx: CanvasRenderingContext2D, text: string, spacing: number): number {
  if (!text) return 0;
  if (!Number.isFinite(spacing) || spacing === 0) return ctx.measureText(text).width;
  let w = 0;
  for (let i = 0; i < text.length; i++) w += ctx.measureText(text[i]).width;
  if (text.length > 1) w += spacing * (text.length - 1);
  return w;
}

function drawRun(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  spacing: number,
  mode: 'fill' | 'stroke',
) {
  if (!text) return;
  if (!Number.isFinite(spacing) || spacing === 0) {
    if (mode === 'fill') ctx.fillText(text, x, y);
    else ctx.strokeText(text, x, y);
    return;
  }
  let cx = x;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (mode === 'fill') ctx.fillText(ch, cx, y);
    else ctx.strokeText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}

export class SubtitleRenderer {
  private cues: AssCue[] = [];
  private compiled: CompiledASS | null = null;
  private supCues: SupCue[] = [];

  loadAss(content: string) {
    this.disposeSupCues();
    this.cues = [];
    try {
      this.compiled = compile(content, {
        defaultInfo: { PlayResX: 1280, PlayResY: 720 },
      });
    } catch {
      this.compiled = null;
      this.cues = parseAss(content);
    }
  }

  async loadSup(data: Uint8Array) {
    this.disposeSupCues();
    this.cues = [];
    this.compiled = null;
    const decoder = new SupDecoder();
    this.supCues = await decoder.decode(data);
  }

  addCue(cue: AssCue) {
    if (!cue) return;
    if (!Number.isFinite(cue.startUs) || !Number.isFinite(cue.endUs)) return;
    if (cue.endUs <= cue.startUs) return;
    const text = String(cue.text ?? '').trim();
    if (!text) return;

    const next: AssCue = { startUs: cue.startUs, endUs: cue.endUs, text };
    const cues = this.cues;
    if (cues.length === 0 || next.startUs >= cues[cues.length - 1].startUs) {
      cues.push(next);
      return;
    }

    // Insert in start-time order.
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cues[mid].startUs <= next.startUs) lo = mid + 1;
      else hi = mid;
    }
    cues.splice(lo, 0, next);
  }

  clear() {
    this.disposeSupCues();
    this.cues = [];
    this.compiled = null;
  }

  getTextAt(timeUs: number): string {
    if (!Number.isFinite(timeUs) || timeUs < 0) return '';
    const cues = this.cues;
    if (cues.length === 0) return '';

    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cues[mid].startUs <= timeUs) lo = mid + 1;
      else hi = mid;
    }

    const idx = lo - 1;
    if (idx < 0) return '';
    const cue = cues[idx];
    if (timeUs >= cue.endUs) return '';
    return cue.text;
  }

  renderToCanvas(timeUs: number, canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const compiled = this.compiled;
    if (compiled) {
      this.renderCompiledAss(ctx, timeUs / 1_000_000, canvas.width, canvas.height);
      return;
    }

    const supCue = this.getSupCueAt(timeUs);
    if (supCue) {
      this.renderSupCue(ctx, supCue, canvas.width, canvas.height);
      return;
    }

    const text = this.getTextAt(timeUs);
    if (!text) return;
    this.renderPlainText(ctx, text, canvas.width, canvas.height);
  }

  private getSupCueAt(timeUs: number): SupCue | null {
    if (!Number.isFinite(timeUs) || timeUs < 0) return null;
    const cues = this.supCues;
    if (cues.length === 0) return null;

    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cues[mid]!.startUs <= timeUs) lo = mid + 1;
      else hi = mid;
    }

    const idx = lo - 1;
    if (idx < 0) return null;
    const cue = cues[idx]!;
    if (timeUs >= cue.endUs) return null;
    return cue;
  }

  private renderSupCue(ctx: CanvasRenderingContext2D, cue: SupCue, canvasW: number, canvasH: number) {
    const screenW = Number(cue.screenW ?? 0);
    const screenH = Number(cue.screenH ?? 0);
    if (!Number.isFinite(screenW) || !Number.isFinite(screenH) || screenW <= 0 || screenH <= 0) return;

    const scale = Math.min(canvasW / screenW, canvasH / screenH);
    const offsetX = (canvasW - screenW * scale) / 2;
    const offsetY = (canvasH - screenH * scale) / 2;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    try {
      ctx.imageSmoothingQuality = 'high';
    } catch {
      // ignore
    }

    for (const bmp of cue.bitmaps) {
      const dx = offsetX + bmp.x * scale;
      const dy = offsetY + bmp.y * scale;
      if (bmp.crop) {
        const dw = bmp.crop.width * scale;
        const dh = bmp.crop.height * scale;
        ctx.drawImage(
          bmp.source,
          bmp.crop.x,
          bmp.crop.y,
          bmp.crop.width,
          bmp.crop.height,
          dx,
          dy,
          dw,
          dh,
        );
      } else {
        const dw = bmp.width * scale;
        const dh = bmp.height * scale;
        ctx.drawImage(bmp.source, dx, dy, dw, dh);
      }
    }

    ctx.restore();
  }

  private disposeSupCues() {
    const cues = this.supCues;
    this.supCues = [];
    for (const cue of cues) {
      for (const bmp of cue.bitmaps) {
        const src = bmp.source as any;
        if (src && typeof src.close === 'function') {
          try {
            src.close();
          } catch {
            // ignore
          }
        }
      }
    }
  }

  private renderPlainText(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
    const lines = text.split('\n');
    const fontSize = Math.max(14, Math.min(48, Math.floor(h * 0.055)));
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = `600 ${fontSize}px system-ui, -apple-system, Segoe UI, Arial, sans-serif`;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const lineHeight = fontSize * 1.2;
    const startY = h - Math.max(12, Math.floor(h * 0.08)) - (lines.length - 1) * lineHeight;

    for (let i = 0; i < lines.length; i++) {
      const y = startY + i * lineHeight;
      const x = w / 2;
      ctx.lineWidth = Math.max(3, fontSize * 0.18);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.strokeText(lines[i], x, y);
      ctx.fillText(lines[i], x, y);
    }

    ctx.restore();
  }

  private renderCompiledAss(ctx: CanvasRenderingContext2D, timeSec: number, canvasW: number, canvasH: number) {
    const ass = this.compiled;
    if (!ass) return;
    if (!Number.isFinite(timeSec)) return;

    const scriptW = Number(ass.width ?? ass.info?.PlayResX ?? 1280) || 1280;
    const scriptH = Number(ass.height ?? ass.info?.PlayResY ?? 720) || 720;
    if (scriptW <= 0 || scriptH <= 0) return;

    const scale = Math.min(canvasW / scriptW, canvasH / scriptH);
    const offsetX = (canvasW - scriptW * scale) / 2;
    const offsetY = (canvasH - scriptH * scale) / 2;

    const dialogues: any[] = Array.isArray((ass as any).dialogues) ? (ass as any).dialogues : [];
    const active = dialogues.filter((d) => typeof d?.start === 'number' && typeof d?.end === 'number' && timeSec >= d.start && timeSec < d.end);
    active.sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0));

    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    for (const dia of active) {
      this.renderDialogue(ctx, dia, timeSec, scriptW, scriptH, (ass as any).styles ?? {});
    }

    ctx.restore();
  }

  private renderDialogue(
    ctx: CanvasRenderingContext2D,
    dia: any,
    timeSec: number,
    scriptW: number,
    scriptH: number,
    styles: Record<string, any>,
  ) {
    const start = Number(dia.start ?? 0);
    const end = Number(dia.end ?? 0);
    const durationMs = Math.max(0, (end - start) * 1000);
    const timeMs = (timeSec - start) * 1000;

    const alignment = Number(dia.alignment ?? 2);
    const { ax, ay, h, v } = alignToAnchor(alignment);

    const margin = dia.margin ?? {};
    const marginL = Number(margin.left ?? 10);
    const marginR = Number(margin.right ?? 10);
    const marginV = Number(margin.vertical ?? 10);

    const pos = this.computeDialoguePos(dia, scriptW, scriptH, timeMs, durationMs, { h, v }, { marginL, marginR, marginV });
    const x = pos.x;
    const y = pos.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const fadeOpacity = computeFadeOpacity(dia.fade, timeMs, durationMs);
    if (fadeOpacity <= 0.001) return;

    const linesRes = this.buildDialogueLines(ctx, dia, styles, timeMs);
    const lines = linesRes.lines;
    const rep = linesRes.representative;
    if (!rep || lines.length === 0) return;

    const lineHeight = Math.max(1, rep.fontSize * 1.2);
    const lineWidths: number[] = [];
    let blockW = 0;
    for (const line of lines) {
      let w = 0;
      for (const seg of line) {
        setFontFromTag(ctx, seg.tag);
        const spacing = Number(seg.tag?.fsp ?? 0) || 0;
        w += measureRunWidth(ctx, seg.text, spacing);
      }
      lineWidths.push(w);
      if (w > blockW) blockW = w;
    }
    const blockH = lineHeight * lines.length;
    if (blockW <= 0 || blockH <= 0) return;

    const left = x - ax * blockW;
    const top = y - ay * blockH;

    ctx.save();

    // Clip (rect only).
    const clip = dia.clip;
    if (clip && clip.dots && typeof clip.dots.x1 === 'number') {
      const x1 = clip.dots.x1;
      const y1 = clip.dots.y1;
      const x2 = clip.dots.x2;
      const y2 = clip.dots.y2;
      const rx = Math.min(x1, x2);
      const ry = Math.min(y1, y2);
      const rw = Math.abs(x2 - x1);
      const rh = Math.abs(y2 - y1);
      ctx.beginPath();
      if (clip.inverse) {
        ctx.rect(0, 0, scriptW, scriptH);
        ctx.rect(rx, ry, rw, rh);
        ctx.clip('evenodd');
      } else {
        ctx.rect(rx, ry, rw, rh);
        ctx.clip();
      }
    }

    // Basic transform (\fscx, \fscy, \fax, \fay, \frz) around the dialogue position.
    const org = dia.org && typeof dia.org.x === 'number' && typeof dia.org.y === 'number' ? dia.org : { x, y };
    const ox = Number(org.x);
    const oy = Number(org.y);
    const scaleX = Number(rep.tag?.fscx ?? 100) / 100;
    const scaleY = Number(rep.tag?.fscy ?? 100) / 100;
    const fax = Number(rep.tag?.fax ?? 0) || 0;
    const fay = Number(rep.tag?.fay ?? 0) || 0;
    const frz = Number(rep.tag?.frz ?? 0) || 0;

    ctx.translate(ox, oy);
    if (Number.isFinite(frz) && frz !== 0) ctx.rotate((frz * Math.PI) / 180);
    if ((fax || fay) && (Number.isFinite(fax) || Number.isFinite(fay))) ctx.transform(1, fay, fax, 1, 0, 0);
    if ((scaleX !== 1 || scaleY !== 1) && Number.isFinite(scaleX) && Number.isFinite(scaleY)) ctx.scale(scaleX, scaleY);
    ctx.translate(-ox, -oy);

    // Opaque box background.
    if (rep.borderStyle === 3) {
      ctx.fillStyle = rgbaFromAss(rep.tag, 'c4', 'a4', fadeOpacity);
      ctx.fillRect(left, top, blockW, blockH);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineW = lineWidths[i] ?? 0;
      let lineX = left;
      if (h === 'center') lineX = left + (blockW - lineW) / 2;
      else if (h === 'right') lineX = left + (blockW - lineW);
      const lineY = top + i * lineHeight;

      let cursorX = lineX;
      for (const seg of line) {
        const tag = seg.tag;
        setFontFromTag(ctx, tag);

        const spacing = Number(tag?.fsp ?? 0) || 0;
        const segW = measureRunWidth(ctx, seg.text, spacing);

        const blur = Math.max(0, Number(tag?.blur ?? 0) || 0, Number(tag?.be ?? 0) || 0);
        ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';

        const xbord = Math.max(0, Number(tag?.xbord ?? 0) || 0);
        const ybord = Math.max(0, Number(tag?.ybord ?? 0) || 0);
        const border = (xbord + ybord) / 2;

        const xshad = Number(tag?.xshad ?? 0) || 0;
        const yshad = Number(tag?.yshad ?? 0) || 0;

        // Shadow.
        if ((xshad || yshad) && rep.borderStyle !== 3) {
          ctx.fillStyle = rgbaFromAss(tag, 'c4', 'a4', fadeOpacity);
          drawRun(ctx, seg.text, cursorX + xshad, lineY + yshad, spacing, 'fill');
        }

        // Outline.
        if (border > 0 && rep.borderStyle !== 3) {
          ctx.lineJoin = 'round';
          ctx.miterLimit = 2;
          ctx.lineWidth = border * 2;
          ctx.strokeStyle = rgbaFromAss(tag, 'c3', 'a3', fadeOpacity);
          drawRun(ctx, seg.text, cursorX, lineY, spacing, 'stroke');
        }

        // Fill.
        ctx.fillStyle = rgbaFromAss(tag, 'c1', 'a1', fadeOpacity);
        drawRun(ctx, seg.text, cursorX, lineY, spacing, 'fill');

        cursorX += segW;
      }
    }

    ctx.restore();
  }

  private computeDialoguePos(
    dia: any,
    scriptW: number,
    scriptH: number,
    timeMsFromStart: number,
    durationMs: number,
    align: { h: 'left' | 'center' | 'right'; v: 'top' | 'middle' | 'bottom' },
    margins: { marginL: number; marginR: number; marginV: number },
  ): { x: number; y: number } {
    if (dia.move && typeof dia.move.x1 === 'number') {
      const x1 = dia.move.x1;
      const y1 = dia.move.y1;
      const x2 = dia.move.x2;
      const y2 = dia.move.y2;
      let t1 = Number(dia.move.t1 ?? 0);
      let t2 = Number(dia.move.t2 ?? 0);
      if (t1 === 0 && t2 === 0) {
        t1 = 0;
        t2 = durationMs;
      }
      const p = t2 !== t1 ? clamp01((timeMsFromStart - t1) / Math.max(1, t2 - t1)) : timeMsFromStart >= t2 ? 1 : 0;
      return { x: lerp(x1, x2, p), y: lerp(y1, y2, p) };
    }
    if (dia.pos && typeof dia.pos.x === 'number') {
      return { x: dia.pos.x, y: dia.pos.y };
    }

    const x = align.h === 'left' ? margins.marginL : align.h === 'center' ? scriptW / 2 : scriptW - margins.marginR;
    const y = align.v === 'bottom' ? scriptH - margins.marginV : align.v === 'middle' ? scriptH / 2 : margins.marginV;
    return { x, y };
  }

  private buildDialogueLines(ctx: CanvasRenderingContext2D, dia: any, styles: Record<string, any>, timeMsFromStart: number): { lines: Line[]; representative: { tag: any; fontSize: number; borderStyle: number } | null } {
    const slices: any[] = Array.isArray(dia.slices) ? dia.slices : [];
    const lines: Line[] = [[]];
    let representative: { tag: any; fontSize: number; borderStyle: number } | null = null;

    for (const slice of slices) {
      const styleName = String(slice?.style ?? dia.style ?? 'Default');
      const style = styles[styleName] ?? styles.Default;
      const styleTag = style?.tag ?? {};
      const styleInfo = style?.style ?? {};
      const fragments: any[] = Array.isArray(slice?.fragments) ? slice.fragments : [];

      for (const frag of fragments) {
        const rawText = typeof frag?.text === 'string' ? frag.text : '';
        if (!rawText) continue;

        const mergedTag = applyTagTransforms({ ...styleTag, ...(frag.tag ?? {}) }, timeMsFromStart);
        const text = normalizeAssText(rawText);
        if (!text) continue;

        if (!representative) {
          setFontFromTag(ctx, mergedTag);
          const fontSize = Number(mergedTag?.fs ?? 20);
          representative = {
            tag: mergedTag,
            fontSize: Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 20,
            borderStyle: Number(styleInfo?.BorderStyle ?? 1) || 1,
          };
        }

        let remaining = text;
        while (true) {
          const idx = remaining.indexOf('\n');
          if (idx === -1) {
            if (remaining) lines[lines.length - 1].push({ text: remaining, tag: mergedTag, style });
            break;
          }
          const before = remaining.slice(0, idx);
          if (before) lines[lines.length - 1].push({ text: before, tag: mergedTag, style });
          lines.push([]);
          remaining = remaining.slice(idx + 1);
        }
      }
    }

    // Trim empty trailing lines.
    while (lines.length > 0 && lines[lines.length - 1].length === 0) lines.pop();

    return { lines, representative };
  }
}
