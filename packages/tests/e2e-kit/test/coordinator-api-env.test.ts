import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assertCoordinatorApiE2eEnv,
  hasCoordinatorApiE2eEnv,
} from "../src/coordinator-api-env.js";

describe("coordinator-api-env", () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
  });

  afterEach(() => {
    process.env = env;
  });

  it("hasCoordinatorApiE2eEnv is false when vars missing", () => {
    delete process.env.DELEGATION_COORDINATOR_URL;
    delete process.env.COORDINATOR_APP_TOKEN;
    expect(hasCoordinatorApiE2eEnv()).toBe(false);
  });

  it("assertCoordinatorApiE2eEnv returns trimmed base URL", () => {
    process.env.DELEGATION_COORDINATOR_URL = "https://coord.example/";
    process.env.COORDINATOR_APP_TOKEN = "token";
    expect(assertCoordinatorApiE2eEnv()).toEqual({
      baseUrl: "https://coord.example",
      appToken: "token",
    });
  });
});
