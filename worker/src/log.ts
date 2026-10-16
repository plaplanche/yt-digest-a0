import { parseLogEvent, type LogEvent, type LogEventName } from "./contracts/log-event";

/** The fields of a log line that the caller gives; `attrs` is an empty object when absent. */
export interface LogFields {
  level?: LogEvent["level"];
  request_id?: string;
  video_id?: string;
  attrs?: Record<string, unknown>;
}

/**
 * Writes one log line (contracts/log-event.schema.json) as JSON with `console.log`.
 * Only catalogued events type-check, and the line is checked at runtime against the
 * contract, so an event outside the catalogue or an unknown field throws.
 */
export function log(event: LogEventName, fields: LogFields = {}): void {
  const line = parseLogEvent({
    level: "info",
    attrs: {},
    ...fields,
    ts: new Date().toISOString(),
    service: "worker",
    event,
  });
  console.log(JSON.stringify(line));
}
