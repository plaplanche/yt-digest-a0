import { describe, expect, test } from "vitest";
import pkg from "../package.json";
import { parseNodeClaimRequest } from "../src/contracts/node-claim-request";
import { HttpError, readBody } from "../src/http";
import { VERSION } from "../src/version";
import { call, expectError } from "./helpers";

test("VERSION is the version of worker/package.json", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(VERSION).toBe(pkg.version);
});

describe("GET /health", () => {
  test("answers 200 with the version", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "ok", version: pkg.version });
  });

  test("needs no bearer and ignores a wrong one", async () => {
    const response = await call("/health", { headers: { Authorization: "Bearer nope" } });
    expect(response.status).toBe(200);
  });
});

describe("unknown routes", () => {
  test.each([
    ["GET", "/"],
    ["GET", "/nope"],
    ["GET", "/health/"],
    ["GET", "/healthz"],
    ["POST", "/health"],
    ["DELETE", "/health"],
    ["GET", "/ops"],
    ["POST", "/node/unknown"],
  ])("%s %s gives 404 not_found", async (method, path) => {
    await expectError(await call(path, { method }), 404, "not_found");
  });
});

describe("readBody", () => {
  function request(body: string): Request {
    return new Request("http://worker.test/", { method: "POST", body });
  }

  async function rejection(body: string): Promise<unknown> {
    return readBody(request(body), parseNodeClaimRequest).then(
      () => null,
      (error: unknown) => error,
    );
  }

  test("returns a body that matches the schema", async () => {
    expect(await readBody(request('{"max_jobs": 2}'), parseNodeClaimRequest)).toEqual({ max_jobs: 2 });
  });

  test.each([["not json"], [""], ['{"max_jobs": 0}'], ['{"max_jobs": 2, "extra": 1}'], ["[]"]])(
    "%j gives 400 invalid_request",
    async (body) => {
      const error = await rejection(body);
      expect(error).toBeInstanceOf(HttpError);
      await expectError((error as HttpError).response(), 400, "invalid_request");
    },
  );
});
