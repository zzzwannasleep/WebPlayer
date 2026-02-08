export class Canvas2DRenderer {
  readonly kind = 'canvas2d' as const;

  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  async init(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context not available');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  render(source: CanvasImageSource) {
    if (!this.canvas || !this.ctx) return;
    this.ctx.drawImage(source, 0, 0, this.canvas.width, this.canvas.height);
  }

  destroy() {
    this.canvas = null;
    this.ctx = null;
  }
}

