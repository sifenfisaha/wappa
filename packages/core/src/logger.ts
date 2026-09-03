/**
 * Minimal structural logger interface so pino/console both fit; no dependency.
 */
export interface Logger {
  debug(msg: string, data?: object): void;
  info(msg: string, data?: object): void;
  warn(msg: string, data?: object): void;
  error(msg: string, data?: object): void;
}

/** Log severity levels accepted by {@link consoleLogger}. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Console-backed {@link Logger} that drops entries below `level` (default 'info').
 */
export function consoleLogger(level: LogLevel = 'info'): Logger {
  const threshold = LEVEL_ORDER[level];
  const make = (lvl: LogLevel, write: (msg: string, data?: object) => void) => {
    return (msg: string, data?: object): void => {
      if (LEVEL_ORDER[lvl] < threshold) return;
      if (data === undefined) write(msg);
      else write(msg, data);
    };
  };
  return {
    debug: make('debug', console.debug),
    info: make('info', console.info),
    warn: make('warn', console.warn),
    error: make('error', console.error),
  };
}
