/** Callback-side bounded retention. No Promise, Effect, blocked producer, or per-frame fiber. */
export class FrameBuffer<A extends { readonly bytes: Uint8Array }> {
  readonly maximumFrames: number;
  readonly maximumBytes: number;
  private readonly items: A[] = [];
  private retained = 0;
  dropped = 0;
  received = 0;
  highWaterBytes = 0;
  highWaterFrames = 0;

  constructor(maximumFrames: number, maximumBytes: number) {
    if (!Number.isSafeInteger(maximumFrames) || maximumFrames < 1 || maximumFrames > 64 ||
        !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024) {
      throw new RangeError("Invalid capture retention limits");
    }
    this.maximumFrames = maximumFrames;
    this.maximumBytes = maximumBytes;
  }

  offer(frame: A): boolean {
    this.received++;
    if (frame.bytes.byteLength > this.maximumBytes) {
      this.dropped++;
      return false;
    }
    while (this.items.length >= this.maximumFrames || this.retained + frame.bytes.byteLength > this.maximumBytes) {
      const removed = this.items.shift();
      if (removed === undefined) break;
      this.retained -= removed.bytes.byteLength;
      this.dropped++;
    }
    this.items.push(frame);
    this.retained += frame.bytes.byteLength;
    this.highWaterBytes = Math.max(this.highWaterBytes, this.retained);
    this.highWaterFrames = Math.max(this.highWaterFrames, this.items.length);
    return true;
  }

  take(): A | undefined {
    const frame = this.items.shift();
    if (frame !== undefined) this.retained -= frame.bytes.byteLength;
    return frame;
  }

  clear(): void {
    this.items.length = 0;
    this.retained = 0;
  }

  get size(): number { return this.items.length; }
  get bytes(): number { return this.retained; }
}
