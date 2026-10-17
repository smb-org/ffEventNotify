// Console progress log: one German line per step, ISO time prefix, token always redacted.

export type LogLevel = 'info' | 'debug';
export type LogSeverity = 'debug' | 'info' | 'warn' | 'error';
export type LogSink = (line: string, severity: LogSeverity) => void;

export function redactToken(text: string, token = process.env.DISCORD_TOKEN): string {
  return token ? text.split(token).join('[Token entfernt]') : text;
}

const defaultSink: LogSink = (line, severity) => {
  if (severity === 'error') console.error(line);
  else if (severity === 'warn') console.warn(line);
  else console.log(line);
};

let currentLevel: LogLevel = 'info';
let currentSink: LogSink = defaultSink;
let currentClock: () => Date = () => new Date();
let guildNames: (guildId: string) => string | undefined = () => undefined;

export function parseLogLevel(value: string | undefined): LogLevel {
  return value?.trim().toLowerCase() === 'debug' ? 'debug' : 'info';
}

/** Replaces level, sink or clock (tests capture lines this way); returns a function that restores the previous setup. */
export function configureLog(options: { level?: LogLevel; sink?: LogSink; clock?: () => Date; guildName?: (guildId: string) => string | undefined }): () => void {
  const previous = { level: currentLevel, sink: currentSink, clock: currentClock, guildName: guildNames };
  if (options.level) currentLevel = options.level;
  if (options.sink) currentSink = options.sink;
  if (options.clock) currentClock = options.clock;
  if (options.guildName) guildNames = options.guildName;
  return () => {
    currentLevel = previous.level;
    currentSink = previous.sink;
    currentClock = previous.clock;
    guildNames = previous.guildName;
  };
}

/** Short single-line form of an error: Discord/API code plus message, never a stack. */
export function briefError(value: unknown): string {
  if (value instanceof Error) return `${(value as { code?: unknown }).code ?? ''} ${value.message}`.trim();
  return String(value);
}

function emit(severity: LogSeverity, message: string, detail?: unknown): void {
  if (severity === 'debug' && currentLevel !== 'debug') return;
  const text = detail === undefined ? message : `${message} ${briefError(detail)}`;
  const prefix = severity === 'warn' ? 'WARNUNG ' : severity === 'error' ? 'FEHLER ' : severity === 'debug' ? 'DEBUG ' : '';
  // Control characters would split one step across several lines.
  const oneLine = redactToken(text).replace(/[\r\n]+/g, ' ');
  currentSink(`${currentClock().toISOString()} ${prefix}${oneLine}`, severity);
}

export const log = {
  info: (message: string): void => emit('info', message),
  debug: (message: string): void => emit('debug', message),
  warn: (message: string, detail?: unknown): void => emit('warn', message, detail),
  error: (message: string, detail?: unknown): void => emit('error', message, detail),
  /** Full stack traces only appear at debug level. */
  stack: (error: unknown): void => {
    if (error instanceof Error && error.stack) emit('debug', error.stack);
  },
};

export function guildLabel(guildId: string): string {
  return guildNames(guildId) ?? guildId;
}

export type ActionKind = 'postCreated' | 'postRecreated' | 'postEdited' | 'postArchived' | 'postUnarchived'
  | 'scheduledCreated' | 'scheduledUpdated' | 'statusEdited' | 'remindersSent';
export type ActionCounts = Record<ActionKind, number>;

const emptyCounts = (): ActionCounts => ({
  postCreated: 0, postRecreated: 0, postEdited: 0, postArchived: 0, postUnarchived: 0,
  scheduledCreated: 0, scheduledUpdated: 0, statusEdited: 0, remindersSent: 0,
});
const counts = new Map<string, ActionCounts>();

/** Counts a Discord action for the cycle summary and the /ffevents abgleichen answer. */
export function countAction(guildId: string, kind: ActionKind): void {
  const entry = counts.get(guildId) ?? emptyCounts();
  entry[kind] += 1;
  counts.set(guildId, entry);
}

/** Cumulative counts; callers subtract an earlier snapshot to get one run. */
export function snapshotActions(guildId?: string): ActionCounts {
  const total = emptyCounts();
  for (const [id, entry] of counts) {
    if (guildId !== undefined && id !== guildId) continue;
    for (const kind of Object.keys(total) as ActionKind[]) total[kind] += entry[kind];
  }
  return total;
}

export function diffActions(after: ActionCounts, before: ActionCounts): ActionCounts {
  const result = emptyCounts();
  for (const kind of Object.keys(result) as ActionKind[]) result[kind] = after[kind] - before[kind];
  return result;
}

/** Logs one Discord action for a server and counts it. */
export function logAction(guildId: string, kind: ActionKind, message: string): void {
  countAction(guildId, kind);
  log.info(`${guildLabel(guildId)}: ${message}`);
}
