export class RingBuffer<T> {
  private buffer: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('RingBuffer capacity must be > 0');
    }
    this.buffer = new Array<T | undefined>(capacity);
  }

  get length() {
    return this.count;
  }

  clear() {
    this.buffer.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this.count = 0;
  }

  push(value: T): boolean {
    if (this.count >= this.capacity) return false;
    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this.capacity;
    this.count += 1;
    return true;
  }

  shift(): T | undefined {
    if (this.count === 0) return undefined;
    const value = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.count -= 1;
    return value;
  }

  peek(): T | undefined {
    if (this.count === 0) return undefined;
    return this.buffer[this.head];
  }
}

