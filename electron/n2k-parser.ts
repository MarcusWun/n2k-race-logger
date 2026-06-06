import { FromPgn } from '@canboat/canboatjs';
import { EventEmitter } from 'events';

export interface PGNMessage {
  pgn: number;
  fields: Record<string, string | number>;
  timestamp: string;
  raw?: string;
}

export interface N2KParserConfig {
  pgnFilter: number[];
  bufferSize: number;
  batchIntervalMs: number;
}

export class N2KParser extends EventEmitter {
  private fromPgn: FromPgn;
  private pgnFilter: number[];
  private buffer: PGNMessage[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private batchIntervalMs: number;

  constructor(config?: Partial<N2KParserConfig>) {
    super();
    this.fromPgn = new FromPgn({
      url: '',
      debug: () => {},
    });
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
   * Parse an Actisense ASCII string (e.g., "36462c3e00...").
   * Returns the parsed message or null if PGN is filtered out.
   */
  parse(line: string): PGNMessage | null {
    try {
      const result = this.fromPgn.parseString(line);
      if (!result || !result.pgn) {
        return null;
      }

      const pgnNum = Number(result.pgn);

      // Check if PGN is in filter
      if (!this.pgnFilter.includes(pgnNum)) {
        return null;
      }

      const timestamp = (result.fields as any)?.timestamp
        ? new Date((result.fields as any).timestamp).toISOString()
        : new Date().toISOString();

      const message: PGNMessage = {
        pgn: pgnNum,
        fields: result.fields as any,
        timestamp,
        raw: line,
      };

      return message;
    } catch (err) {
      // Try to extract PGN number from raw hex for unknown PGNs
      const hexMatch = line.match(/^([0-9a-fA-F]+)/);
      if (hexMatch) {
        try {
          const hexStr = hexMatch[1];
          if (hexStr.length >= 4) {
            const pgnHex = hexStr.slice(0, 4);
            const pgnNum = parseInt(pgnHex, 16);
            if (!this.pgnFilter.includes(pgnNum)) {
              return null;
            }
            // Log unknown PGN with raw bytes
            this.emit('unknown', { pgn: pgnNum, raw: line });
          }
        } catch {
          // ignore parse errors on unknown format
        }
      }
      return null;
    }
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
