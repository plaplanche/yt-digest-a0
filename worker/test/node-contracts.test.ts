/// <reference types="vite/client" />
import { describe, expect, expectTypeOf, test } from "vitest";
import { parseErrorResponse } from "../src/contracts/error";
import { parseNodeClaimRequest } from "../src/contracts/node-claim-request";
import { parseNodeClaimResponse } from "../src/contracts/node-claim-response";
import { parseNodeHeartbeatRequest } from "../src/contracts/node-heartbeat-request";
import { parseNodeHeartbeatResponse } from "../src/contracts/node-heartbeat-response";
import { parseNodeJobAck } from "../src/contracts/node-job-ack";
import { parseNodeReleaseRequest } from "../src/contracts/node-release-request";
import { parseNodeResultRequest, type NodeResultRequest } from "../src/contracts/node-result-request";
import resultRequestSource from "../src/contracts/node-result-request.ts?raw";
import type { TranscriptResult } from "../src/contracts/transcript-result";

const ts = "2026-10-16T07:00:01.123Z";
const transcript: TranscriptResult = {
  video_id: "dQw4w9WgXcQ",
  status: "ok",
  lang: "fr",
  source: "manual",
  word_count: 3,
  truncated: false,
  sponsor_ratio: 0,
  pages: ["un deux trois"],
};
const job = { video_id: "dQw4w9WgXcQ", lease_id: "0123456789abcdef", lease_expires_at: ts };
const heartbeat = { version: "0.2.0", uptime_s: 120, jobs_in_progress: 1 };

type Parse = (value: unknown) => unknown;

const valid: [string, Parse, Record<string, unknown>][] = [
  [
    "a full heartbeat",
    parseNodeHeartbeatRequest,
    { ...heartbeat, last_success_at: ts, last_blocked_at: null, disk_free_ratio: 0.5, cpu_temp_c: 48.5 },
  ],
  ["a minimal heartbeat", parseNodeHeartbeatRequest, heartbeat],
  [
    "a heartbeat response",
    parseNodeHeartbeatResponse,
    { node_id: "n1", state: "healthy", hourly_budget: 30, directive: "run" },
  ],
  ["a claim of 1", parseNodeClaimRequest, { max_jobs: 1 }],
  ["a claim of 10", parseNodeClaimRequest, { max_jobs: 10 }],
  ["a claim without max_jobs", parseNodeClaimRequest, {}],
  ["a claim response", parseNodeClaimResponse, { jobs: [job] }],
  ["an empty claim response", parseNodeClaimResponse, { jobs: [] }],
  ["an ok result", parseNodeResultRequest, { lease_id: "l", outcome: "ok", transcript }],
  ["an error result", parseNodeResultRequest, { lease_id: "l", outcome: "error", transcript: null }],
  ["a release", parseNodeReleaseRequest, { lease_id: "l" }],
  ["a job ack", parseNodeJobAck, { video_id: "dQw4w9WgXcQ", status: "failed_video" }],
  ["an error body", parseErrorResponse, { error: { code: "stale_lease", message: "lease expired" } }],
];

describe("node protocol contracts", () => {
  test.each(valid)("%s is accepted", (_, parse, value) => {
    expect(parse(value)).toEqual(value);
  });

  test.each(valid)("%s with an extra field is rejected", (_, parse, value) => {
    expect(() => parse({ ...value, extra: 1 })).toThrow(/unknown field extra/);
  });

  test.each<[string, Parse, unknown]>([
    ["a heartbeat without version", parseNodeHeartbeatRequest, { uptime_s: 1, jobs_in_progress: 0 }],
    ["an empty version", parseNodeHeartbeatRequest, { ...heartbeat, version: "" }],
    ["a version of 65 characters", parseNodeHeartbeatRequest, { ...heartbeat, version: "v".repeat(65) }],
    ["a null cpu_temp_c", parseNodeHeartbeatRequest, { ...heartbeat, cpu_temp_c: null }],
    ["a disk_free_ratio above 1", parseNodeHeartbeatRequest, { ...heartbeat, disk_free_ratio: 2 }],
    ["a timestamp without milliseconds", parseNodeHeartbeatRequest, { ...heartbeat, last_success_at: "2026-10-16T07:00:01Z" }],
    ["an unknown state", parseNodeHeartbeatResponse, { node_id: "n1", state: "sick", hourly_budget: 30, directive: "run" }],
    ["a max_jobs of 0", parseNodeClaimRequest, { max_jobs: 0 }],
    ["a max_jobs of 11", parseNodeClaimRequest, { max_jobs: 11 }],
    ["a fractional max_jobs", parseNodeClaimRequest, { max_jobs: 2.5 }],
    ["a short lease_id", parseNodeClaimResponse, { jobs: [{ ...job, lease_id: "too-short" }] }],
    ["a job with an extra field", parseNodeClaimResponse, { jobs: [{ ...job, extra: 1 }] }],
    ["a claim response without jobs", parseNodeClaimResponse, {}],
    ["an unknown outcome", parseNodeResultRequest, { lease_id: "l", outcome: "done", transcript: null }],
    ["a transcript with bad pages", parseNodeResultRequest, { lease_id: "l", outcome: "ok", transcript: { ...transcript, pages: 1 } }],
    ["a transcript with an extra field", parseNodeResultRequest, { lease_id: "l", outcome: "ok", transcript: { ...transcript, x: 1 } }],
    ["a result without transcript", parseNodeResultRequest, { lease_id: "l", outcome: "ok" }],
    ["an empty lease_id", parseNodeReleaseRequest, { lease_id: "" }],
    ["an unknown job status", parseNodeJobAck, { video_id: "dQw4w9WgXcQ", status: "lost" }],
    ["an error without message", parseErrorResponse, { error: { code: "stale_lease" } }],
    ["an error with an extra field", parseErrorResponse, { error: { code: "c", message: "m", extra: 1 } }],
  ])("%s is rejected", (_, parse, value) => {
    expect(() => parse(value)).toThrow();
  });

  test("the result request uses the generated transcript-result type", () => {
    expectTypeOf<NodeResultRequest["transcript"]>().toEqualTypeOf<TranscriptResult | null>();
    expect(resultRequestSource).toContain(
      'import { checkTranscriptResult, type TranscriptResult } from "./transcript-result";',
    );
    expect(resultRequestSource).not.toMatch(/interface TranscriptResult|TRANSCRIPT_RESULT_FIELDS/);
  });
});
