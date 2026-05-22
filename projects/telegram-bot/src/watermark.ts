/**
 * WatermarkTracker — contiguous ack watermark for at-least-once Telegram offset management.
 *
 * Decouples the in-memory poll cursor (advances immediately after a batch is received)
 * from the persisted ack offset (advances only when all updates up to a point are done).
 *
 * complete(id) returns the new ack offset when the contiguous frontier advances,
 * or -1 if there is still a gap below the completed ID.
 */
export class WatermarkTracker {
  private pending = new Set<number>(); // in-flight update IDs
  private highWater: number;           // highest registered update ID
  private _ackOffset: number;          // contiguous completed watermark

  constructor(initialOffset: number) {
    this._ackOffset = initialOffset;
    this.highWater = initialOffset;
  }

  /** Register an update as in-flight. Must be called before firing processUpdate. */
  register(updateId: number): void {
    this.pending.add(updateId);
    if (updateId > this.highWater) this.highWater = updateId;
  }

  /**
   * Mark an update as complete. Returns the new ack offset if the contiguous
   * frontier advanced, or -1 if a gap still exists below this update.
   */
  complete(updateId: number): number {
    if (!this.pending.has(updateId)) return -1; // no-op for unregistered IDs
    this.pending.delete(updateId);

    let newAck: number;
    if (this.pending.size === 0) {
      // All updates complete — safe to ack up to the highest we've seen.
      newAck = this.highWater;
    } else {
      // Still in-flight updates exist. Ack up to (minPending - 1) so we
      // don't skip any gaps in the delivery stream.
      let minPending = this.highWater;
      for (const pending of this.pending) {
        if (pending < minPending) minPending = pending;
      }
      newAck = minPending - 1;
    }

    if (newAck > this._ackOffset) {
      this._ackOffset = newAck;
      return newAck;
    }
    return -1;
  }

  get ackOffset(): number { return this._ackOffset; }
  get hasPending(): boolean { return this.pending.size > 0; }
  get pendingCount(): number { return this.pending.size; }
}
