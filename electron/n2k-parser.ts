import { EventEmitter } from 'events';
import type { ParsedPGN } from './serial-manager';

export interface PGNMessage {
  pgn: number;
  src?: number;
  fields: Record<string, any>;
  timestamp: string;
}

export interface N2KParserConfig {
  batchIntervalMs: number;
}

export class N2KParser extends EventEmitter {
  private buffer: PGNMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private batchIntervalMs: number;

  constructor(config?: Partial<N2KParserConfig>) {
    super();
    this.batchIntervalMs = config?.batchIntervalMs ?? 250;
  }

  /**
   * Normalize a pre-parsed PGN object from serial-manager into PGNMessage format.
   * All PGNs pass through unconditionally — filtering is not performed here.
   * Returns null only if the input is missing required fields.
   */
  normalizeParsedPgn(parsed: ParsedPGN): PGNMessage | null {
    if (parsed.pgn == null) return null;
    return {
      pgn: parsed.pgn,
      src: parsed.src,
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
