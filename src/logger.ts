import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { PluginLogger } from "./webhook/logger-types";

function timestamp(): string {
  return new Date().toLocaleString("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).replace(" ", "T");
}

export function createLogger(logDir: string): PluginLogger {
  mkdirSync(logDir, { recursive: true });

  const logFile = join(
    logDir,
    `${new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })}.log`,
  );
  const stream: WriteStream = createWriteStream(logFile, { flags: "a" });

  function write(level: string, message: string) {
    const line = `${timestamp()} [${level}] ${message}`;
    console.log(line);
    stream.write(line + "\n");
  }

  return {
    debug: (msg: string) => write("DEBUG", msg),
    info: (msg: string) => write("INFO", msg),
    warn: (msg: string) => write("WARN", msg),
    error: (msg: string) => write("ERROR", msg),
  };
}
