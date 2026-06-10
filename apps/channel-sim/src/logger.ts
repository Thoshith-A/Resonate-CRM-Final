type LogLevel = "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

function write(level: LogLevel, msg: string, fields?: LogFields): void {
  const line = JSON.stringify({
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  });
  const stream = level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const logger = {
  info: (msg: string, fields?: LogFields): void => write("info", msg, fields),
  warn: (msg: string, fields?: LogFields): void => write("warn", msg, fields),
  error: (msg: string, fields?: LogFields): void => write("error", msg, fields),
};

export type Logger = typeof logger;
