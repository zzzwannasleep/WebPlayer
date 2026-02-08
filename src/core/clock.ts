export class MediaClock {
  private baseTimestampUs = 0;
  private baseWallClockMs = 0;
  private pausedAtWallClockMs: number | null = null;
  private pausedAtTimestampUs = 0;
  private playbackRate = 1;

  start(startTimestampUs: number, nowWallClockMs = performance.now()) {
    this.baseTimestampUs = startTimestampUs;
    this.baseWallClockMs = nowWallClockMs;
    this.pausedAtWallClockMs = null;
    this.pausedAtTimestampUs = startTimestampUs;
  }

  setRate(rate: number) {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('rate must be > 0');
    const current = this.nowUs();
    this.playbackRate = rate;
    if (this.pausedAtWallClockMs === null) {
      this.baseTimestampUs = current;
      this.baseWallClockMs = performance.now();
    } else {
      this.pausedAtTimestampUs = current;
    }
  }

  pause(nowWallClockMs = performance.now()) {
    if (this.pausedAtWallClockMs !== null) return;
    this.pausedAtWallClockMs = nowWallClockMs;
    this.pausedAtTimestampUs = this.nowUs(nowWallClockMs);
  }

  resume(nowWallClockMs = performance.now()) {
    if (this.pausedAtWallClockMs === null) return;
    this.baseTimestampUs = this.pausedAtTimestampUs;
    this.baseWallClockMs = nowWallClockMs;
    this.pausedAtWallClockMs = null;
  }

  seek(timestampUs: number, nowWallClockMs = performance.now()) {
    this.baseTimestampUs = timestampUs;
    this.baseWallClockMs = nowWallClockMs;
    if (this.pausedAtWallClockMs !== null) {
      this.pausedAtTimestampUs = timestampUs;
      this.pausedAtWallClockMs = nowWallClockMs;
    }
  }

  nowUs(nowWallClockMs = performance.now()): number {
    if (this.pausedAtWallClockMs !== null) return this.pausedAtTimestampUs;
    const elapsedMs = nowWallClockMs - this.baseWallClockMs;
    return this.baseTimestampUs + elapsedMs * 1000 * this.playbackRate;
  }
}

