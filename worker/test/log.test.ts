import { afterEach, expect, test, vi } from "vitest";
import { log } from "../src/log";

afterEach(() => {
  vi.restoreAllMocks();
});

function capture(): () => unknown[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => spy.mock.calls.map((call) => JSON.parse(String(call[0])) as unknown);
}

test("log writes one JSON line of the catalogue", () => {
  const lines = capture();
  log("service.started", { request_id: "r1", attrs: { version: "0.1.0" } });
  const [line, ...others] = lines() as Record<string, unknown>[];
  expect(others).toEqual([]);
  const { ts, ...rest } = line;
  expect(ts).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(rest).toEqual({
    level: "info",
    service: "worker",
    event: "service.started",
    request_id: "r1",
    attrs: { version: "0.1.0" },
  });
});

test("log defaults attrs to an empty object and takes a level", () => {
  const lines = capture();
  log("service.started", { level: "warn" });
  expect(lines()).toMatchObject([{ level: "warn", attrs: {} }]);
});

test("log accepts a lot 2 event", () => {
  const lines = capture();
  log("job.claimed", { video_id: "dQw4w9WgXcQ", attrs: { node_id: "n1", attempt: 1, lease_seconds: 2 } });
  expect(lines()).toMatchObject([{ event: "job.claimed", video_id: "dQw4w9WgXcQ" }]);
});

test("an event outside the catalogue throws", () => {
  const lines = capture();
  // @ts-expect-error: the type system rejects an event outside the catalogue
  expect(() => log("video.deleted")).toThrow(/invalid field event/);
  expect(lines()).toEqual([]);
});

test("an unknown field throws", () => {
  // @ts-expect-error: the type system rejects an unknown field
  expect(() => log("service.started", { extra: 1 })).toThrow(/unknown field extra/);
});
