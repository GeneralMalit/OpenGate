export type LogLevel = "debug" | "info" | "warn" | "error";
export type StructuredLogEvent = { level: LogLevel; event: string; timestamp?: string; requestId?: string; [key: string]: unknown };
export type StructuredLogger = { emit(event: StructuredLogEvent): void; child(fields: Record<string, unknown>): StructuredLogger };

const SECRET_KEYS = /(?:authorization|cookie|secret|password|token|api[-_]?key|key[-_]?pepper|session)/i;

export function redactLogValue(value: unknown, key = ""): unknown {
  if (SECRET_KEYS.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactLogValue(item, name)]));
  return value;
}

export function createStructuredLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = console.log): StructuredLogger {
  const emit = (event: StructuredLogEvent) => sink(JSON.stringify(redactLogValue({ ...base, ...event, timestamp: event.timestamp ?? new Date().toISOString() }) as object));
  return { emit, child(fields) { return createStructuredLogger({ ...base, ...redactLogValue(fields) as Record<string, unknown> }, sink); } };
}
