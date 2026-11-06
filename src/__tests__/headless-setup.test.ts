import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { hasHeadlessEnv, HEADLESS_TREASURY_POLICY } from "../setup/headless.js";

const KEYS = [
  "HOME", "AUTOMATON_NAME", "AUTOMATON_GENESIS_PROMPT", "AUTOMATON_CREATOR_ADDRESS",
  "AUTOMATON_CHAIN", "AUTOMATON_MAX_CHILDREN", "CONWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
];

describe("headless setup", () => {
  const saved: Record<string, string | undefined> = {};
  let home: string;
  let runHeadlessSetup: typeof import("../setup/headless.js").runHeadlessSetup;

  beforeEach(async () => {
    vi.resetModules();
    for (const k of KEYS) saved[k] = process.env[k];
    for (const k of KEYS) delete process.env[k];
    home = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-headless-"));
    process.env.HOME = home;
    process.env.AUTOMATON_NAME = "t";
    process.env.AUTOMATON_GENESIS_PROMPT = "hello";
    process.env.AUTOMATON_CREATOR_ADDRESS = "0x1dF7C167eC75a6537F5D387CE71534821fF04B59";
    // wallet.ts reads HOME at import time, so re-import after setting it
    ({ runHeadlessSetup } = await import("../setup/headless.js"));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("detects headless env", () => {
    expect(hasHeadlessEnv()).toBe(true);
    delete process.env.AUTOMATON_NAME;
    expect(hasHeadlessEnv()).toBe(false);
  });

  it("writes a locked-down config with maxChildren 0 by default", async () => {
    process.env.CONWAY_API_KEY = "cnwy_k_test";
    const config = await runHeadlessSetup();
    expect(config.maxChildren).toBe(0);
    expect(config.treasuryPolicy).toEqual(HEADLESS_TREASURY_POLICY);
    expect(config.soulConfig?.requireCreatorApprovalForPurposeChange).toBe(true);
    expect(fs.existsSync(path.join(home, ".automaton", "automaton.json"))).toBe(true);
  });

  it("rejects an invalid creator address", async () => {
    process.env.CONWAY_API_KEY = "cnwy_k_test";
    process.env.AUTOMATON_CREATOR_ADDRESS = "nope";
    await expect(runHeadlessSetup()).rejects.toThrow(/CREATOR_ADDRESS/);
  });

  it("fails clearly when no key is given and provisioning is impossible", async () => {
    vi.doMock("../identity/provision.js", () => ({
      provision: async () => { throw new Error("offline"); },
      loadApiKeyFromConfig: () => undefined,
    }));
    vi.resetModules();
    const mod = await import("../setup/headless.js");
    await expect(mod.runHeadlessSetup()).rejects.toThrow(/CONWAY_API_KEY/);
    vi.doUnmock("../identity/provision.js");
  });
});
