import { configureLog, type LogLevel } from '../src/log.ts';

/** Captures console log lines; `messages` has the ISO time prefix stripped. */
export function captureLog(level: LogLevel = 'info') {
  const lines: string[] = [];
  const restore = configureLog({
    level,
    sink: (line) => { lines.push(line); },
    clock: () => new Date('2026-10-17T00:00:00.000Z'),
  });
  return {
    lines,
    restore,
    messages: () => lines.map((line) => line.replace(/^\S+ /, '')),
  };
}
