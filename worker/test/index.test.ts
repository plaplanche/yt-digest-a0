import { expect, test } from "vitest";
import { VERSION } from "../src/index";

test("VERSION is a semantic version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
