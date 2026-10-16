import { describe, expect, test } from "vitest";
import { LOG_EVENT_NAMES, parseLogEvent, type LogEventName } from "../src/contracts/log-event";
import { parseTranscriptResult, type TranscriptResult } from "../src/contracts/transcript-result";

const result: TranscriptResult = {
  video_id: "dQw4w9WgXcQ",
  status: "ok",
  lang: "fr",
  source: "manual",
  word_count: 3,
  truncated: false,
  sponsor_ratio: 0.125,
  pages: ["un deux trois"],
};

function without(name: keyof TranscriptResult): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([key]) => key !== name));
}

const line = {
  ts: "2026-10-16T12:00:00.000Z",
  level: "info",
  service: "worker",
  event: "service.started",
  attrs: { version: "0.1.0" },
};

describe("TranscriptResult", () => {
  test("a valid result is accepted", () => {
    expect(parseTranscriptResult(result)).toEqual(result);
  });

  test("a failed result is accepted", () => {
    const failed = { ...result, status: "blocked", lang: null, source: null, word_count: 0, sponsor_ratio: null, pages: [] };
    expect(parseTranscriptResult(failed).status).toBe("blocked");
  });

  test.each([
    ["an extra field", { ...result, extra: "field" }],
    ["a short video_id", { ...result, video_id: "too-short" }],
    ["a bad video_id character", { ...result, video_id: "dQw4w9WgXc!" }],
    ["a bad status", { ...result, status: "done" }],
    ["a bad source", { ...result, source: "human" }],
    ["a negative word_count", { ...result, word_count: -1 }],
    ["a fractional word_count", { ...result, word_count: 1.5 }],
    ["a non-boolean truncated", { ...result, truncated: 0 }],
    ["a sponsor_ratio above 1", { ...result, sponsor_ratio: 1.5 }],
    ["a non-string page", { ...result, pages: [1] }],
    ["a missing field", without("lang")],
    ["an array", [result]],
  ])("a result with %s is rejected", (_, value) => {
    expect(() => parseTranscriptResult(value)).toThrow();
  });
});

describe("LogEvent", () => {
  test("a valid log line is accepted", () => {
    const full = { ...line, request_id: "r1", video_id: "dQw4w9WgXcQ" };
    expect(parseLogEvent(full)).toEqual(full);
  });

  test("the catalogue is a union of the event names", () => {
    const names: readonly LogEventName[] = LOG_EVENT_NAMES;
    expect(names).toEqual([
      "service.started",
      "fetch.transcript",
      "sponsorblock.call",
      "node.enrolled",
      "node.revoked",
      "node.heartbeat",
      "job.enqueued",
      "job.claimed",
      "job.completed",
      "job.released",
      "job.lease_expired",
      "job.stale_result",
      "job.validation_failed",
      "auth.bearer.rejected",
      "auth.client.registered",
      "auth.oauth.completed",
      "auth.oauth.denied",
      "auth.token.issued",
      "auth.refresh.reuse_detected",
      "auth.origin.rejected",
      "mcp.tool.call",
      "worker.call",
    ]);
    // @ts-expect-error: an event outside the catalogue is not a LogEventName
    const unknown: LogEventName = "video.deleted";
    expect(LOG_EVENT_NAMES).not.toContain(unknown);
  });

  test.each([
    ["an unknown event", { ...line, event: "video.deleted" }],
    ["a bad level", { ...line, level: "fatal" }],
    ["a bad service", { ...line, service: "cron" }],
    ["a ts without milliseconds", { ...line, ts: "2026-10-16T12:00:00Z" }],
    ["a null request_id", { ...line, request_id: null }],
    ["an extra field", { ...line, extra: "field" }],
    ["attrs that are not an object", { ...line, attrs: [] }],
  ])("a log line with %s is rejected", (_, value) => {
    expect(() => parseLogEvent(value)).toThrow();
  });
});
