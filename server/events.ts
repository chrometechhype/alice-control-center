import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { AccEvent, EventLevel } from '../shared/types.ts';
import { eventsFile } from './config.ts';
import { newId } from './util.ts';

const MAX_ITEMS = 2000;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/pass|token|secret|key|credential/i.test(key)) {
        out[key] = '[скрыто]';
      } else {
        out[key] = scrub(item, depth + 1);
      }
    }
    return out;
  }
  return value;
}

class EventLog extends EventEmitter {
  private items: AccEvent[] = [];

  init(): void {
    try {
      const raw = fs.readFileSync(eventsFile, 'utf8');
      const lines = raw.split('\n').filter(Boolean).slice(-MAX_ITEMS);
      for (const line of lines) {
        try {
          this.items.push(JSON.parse(line) as AccEvent);
        } catch {
          // повреждённая строка журнала пропускается
        }
      }
    } catch {
      this.items = [];
    }
  }

  append(input: {
    level: EventLevel;
    module: string;
    operation: string;
    result?: AccEvent['result'];
    message: string;
    details?: unknown;
    ts?: number;
  }): AccEvent {
    const event: AccEvent = {
      id: newId('ev'),
      ts: input.ts ?? Date.now(),
      level: input.level,
      module: input.module,
      operation: input.operation,
      result: input.result ?? 'info',
      message: input.message,
      details: input.details === undefined ? undefined : scrub(input.details),
    };
    this.items.push(event);
    if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
    fs.appendFile(eventsFile, `${JSON.stringify(event)}\n`, () => {});
    this.emit('event', event);
    return event;
  }

  list(options: {
    level?: EventLevel | 'all';
    module?: string;
    query?: string;
    limit?: number;
    before?: number;
  } = {}): AccEvent[] {
    const { level, module, query, limit = 200, before } = options;
    let result = this.items;
    if (level && level !== 'all') result = result.filter((event) => event.level === level);
    if (module && module !== 'all') result = result.filter((event) => event.module === module);
    if (before) result = result.filter((event) => event.ts < before);
    if (query) {
      const needle = query.toLowerCase();
      result = result.filter((event) =>
        `${event.module} ${event.operation} ${event.message}`.toLowerCase().includes(needle),
      );
    }
    return result.slice(-limit).reverse();
  }

  modules(): string[] {
    return Array.from(new Set(this.items.map((event) => event.module))).sort();
  }

  count(): number {
    return this.items.length;
  }

  clear(): number {
    const removed = this.items.length;
    this.items = [];
    fs.writeFile(eventsFile, '', () => {});
    this.emit('cleared');
    return removed;
  }

  toJsonl(): string {
    return this.items.map((event) => JSON.stringify(event)).join('\n');
  }
}

export const eventLog = new EventLog();
