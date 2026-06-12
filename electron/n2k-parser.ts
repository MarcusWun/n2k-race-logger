import { EventEmitter } from 'events';
import type { ParsedPGN } from './serial-manager';

export interface PGNMessage {
  pgn: number;
  fields: Record<string, any>;
  timestamp: string;
}

export interface N2KParserConfig {
  pgnFilter: number[];
  batchIntervalMs: number;
}

export class N2KParser extends EventEmitter {
  private pgnFilter: number[];
  private buffer: PGNMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private batchIntervalMs: number;

  constructor(config?: Partial<N2KParserConfig>) {
    super();
    this.pgnFilter = config?.pgnFilter ?? [
      128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284,
    ];
    this.batchIntervalMs = config?.batchIntervalMs ?? 250;
  }

  /**
   * Set the PGN filter list.
   */
  setPGNFilter(pgnFilter: number[]): void {
    this.pgnFilter = [...pgnFilter];
  }

  /**
   * Get the current PGN filter list.
   */
  getPGNFilter(): number[] {
    return [...this.pgnFilter];
  }

  /**
   * Apply the PGN filter to a pre-parsed PGN object from serial-manager.
   * Returns a PGNMessage if the PGN is in the filter, or null if filtered out.
   */
  filter(parsed: ParsedPGN): PGNMessage | null {
    if (!this.pgnFilter.includes(parsed.pgn)) {
      return null;
    }
    return {
      pgn: parsed.pgn,
      fields: parsed.fields,
      timestamp: parsed.timestamp || new Date().toISOString(),
    };
  }

  /**
   * Queue a parsed message for batch writing.
   */
  enqueue(message: PGNMessage): void {
    this.buffer.push(message);
    this.emit('data', message);
  }

  /**
   * Start the batch write interval. Emits 'batch' with the buffered messages
   * every batchIntervalMs milliseconds.
   */
  startBatching(): void {
    this.stopBatching();
    this.batchTimer = setInterval(() => {
      this.flush();
    }, this.batchIntervalMs);
  }

  /**
   * Stop the batch write interval.
   */
  stopBatching(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Flush the buffer — returns buffered messages and clears the buffer.
   * Emits 'batch' event with the flushed messages.
   */
  flush(): PGNMessage[] {
    const batch = [...this.buffer];
    this.buffer = [];
    if (batch.length > 0) {
      this.emit('batch', batch);
    }
    return batch;
  }

  /**
   * Get the current buffer size (unflushed messages).
   */
  getBufferSize(): number {
    return this.buffer.length;
  }
}
