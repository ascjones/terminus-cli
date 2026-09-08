import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE, errorReport, optionalId, parseArgs, run } from "./cli.ts";
import { TerminusError } from "./client.ts";

describe("parseArgs", () => {
  it("separates positionals from flags wherever the flags appear", () => {
    expect(parseArgs(["playlist", "show", "--json", "2", "--verbose"])).toEqual({
      command: ["playlist", "show", "2"],
      json: true,
      verbose: true,
      help: false,
    });
  });

  it("reads the value flags", () => {
    const parsed = parseArgs([
      "devices", "--url", "http://other:2300", "--email", "b@example.com", "--screens", "../screens",
    ]);
    expect(parsed.url).toBe("http://other:2300");
    expect(parsed.email).toBe("b@example.com");
    expect(parsed.screens).toBe("../screens");
  });

  it("rejects a value flag with nothing after it", () => {
    expect(() => parseArgs(["devices", "--url"])).toThrow(/--url needs a value/);
  });

  it("rejects an unknown option rather than treating it as a command", () => {
    expect(() => parseArgs(["devices", "--jsonn"])).toThrow(/Unknown option --jsonn/);
  });
});

describe("optionalId", () => {
  it("accepts a number, absence, and nothing else", () => {
    expect(optionalId("2", "playlist id")).toBe(2);
    expect(optionalId(undefined, "playlist id")).toBeNull();
    expect(() => optionalId("device_2", "playlist id")).toThrow(/Expected a numeric playlist id/);
  });
});

describe("errorReport", () => {
  it("prints a failing response body verbatim under the request line", () => {
    const error = new TerminusError("PUT", "/extensions/1", 422, '{"errors":{"name":["is missing"]}}');
    expect(errorReport(error)).toBe('PUT /extensions/1 -> HTTP 422\n{"errors":{"name":["is missing"]}}');
  });

  it("falls back to the message for anything else", () => {
    expect(errorReport(new Error("boom"))).toBe("boom");
  });
});

describe("run", () => {
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  const dirs: string[] = [];
  const settingsVars = ["TERMINUS_URL", "TERMINUS_EMAIL", "TERMINUS_PASSWORD", "TERMINUS_PASSWORD_REF", "TERMINUS_SCREENS_DIR"];

  /** Run from an empty temp dir so no terminus-cli.json above the checkout leaks in. */
  function isolate(env: Record<string, string> = {}): void {
    const dir = mkdtempSync(join(tmpdir(), "terminus-cli-run-"));
    dirs.push(dir);
    process.chdir(dir);
    for (const name of settingsVars) delete process.env[name];
    Object.assign(process.env, env);
  }

  function captureStdout(): string[] {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    return out;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(saved.cwd);
    for (const name of settingsVars) delete process.env[name];
    for (const name of settingsVars) if (saved.env[name] !== undefined) process.env[name] = saved.env[name];
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("prints usage and exits 1 with no command, 0 with --help", async () => {
    isolate();
    const out = captureStdout();
    expect(await run([])).toBe(1);
    expect(await run(["--help"])).toBe(0);
    expect(out[0]).toContain(USAGE);
  });

  it("reports the settings without touching the network", async () => {
    isolate({ TERMINUS_URL: "http://localhost:2300" });
    const out = captureStdout();
    expect(await run(["config", "--json"])).toBe(0);
    expect(JSON.parse(out.join(""))).toMatchObject({
      config_file: null,
      settings: { url: { value: "http://localhost:2300", source: "TERMINUS_URL" }, email: { value: null, source: null } },
    });
  });

  it("names every source for a missing url or email before any request", async () => {
    isolate();
    await expect(run(["devices"])).rejects.toThrow(/TERMINUS_URL.*terminus-cli\.json.*--url/);
    isolate({ TERMINUS_URL: "http://localhost:2300" });
    await expect(run(["devices"])).rejects.toThrow(/TERMINUS_EMAIL.*terminus-cli\.json.*--email/);
  });

  it("rejects an unknown command or playlist subcommand", async () => {
    isolate({ TERMINUS_URL: "http://localhost:2300", TERMINUS_EMAIL: "a@example.com" });
    await expect(run(["bogus"])).rejects.toThrow(/Unknown command "bogus"/);
    await expect(run(["playlist"])).rejects.toThrow(/Unknown playlist subcommand ""/);
    await expect(run(["playlist", "nope"])).rejects.toThrow(/Unknown playlist subcommand "nope"/);
    await expect(run(["playlist", "show", "abc"])).rejects.toThrow(/numeric playlist id/);
  });
});
