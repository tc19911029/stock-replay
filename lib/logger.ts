/**
 * Centralized logging abstraction layer.
 *
 * Wraps console.* calls with structured metadata.
 * Ready to swap in a real logging service (e.g., Sentry, Pino)
 * by changing the implementation without modifying call sites.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
  timestamp: string;
}

function formatEntry(entry: LogEntry): string {
  return `[${entry.module}] ${entry.message}`;
}

function createLogger(module: string) {
  return {
    debug(message: string, data?: unknown) {
      if (process.env.NODE_ENV === 'development') {
        console.debug(formatEntry({ level: 'debug', module, message, timestamp: new Date().toISOString() }), data ?? '');
      }
    },

    info(message: string, data?: unknown) {
      console.info(formatEntry({ level: 'info', module, message, timestamp: new Date().toISOString() }), data ?? '');
    },

    warn(message: string, data?: unknown) {
      console.warn(formatEntry({ level: 'warn', module, message, timestamp: new Date().toISOString() }), data ?? '');
    },

    error(message: string, error?: unknown) {
      const errorData = error instanceof Error
        ? { message: error.message, stack: error.stack }
        : error;
      console.error(formatEntry({ level: 'error', module, message, timestamp: new Date().toISOString() }), errorData ?? '');

      // Future: send to Sentry, LogRocket, etc.
      // if (typeof Sentry !== 'undefined') Sentry.captureException(error);
    },
  };
}

export { createLogger };
export type { LogLevel, LogEntry };
