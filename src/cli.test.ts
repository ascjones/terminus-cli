import { describe, expect, it } from "vitest";
import { errorReport, optionalId, parseArgs } from "./cli.ts";
import { TerminusError } from "./client.ts";

describe("parseArgs", () => {
  it("separates positionals from flags wherever the flags appear", () => {
    expect(parseArgs(["playlist", "show", "--json", "2", "--verbose"])).toEqual({
      command: ["playlist", "show", "2"],
      json: true,
      verbose: true,
      help: false,
      wait: false,
      build: true,
    });
  });

  it("reads --wait and --no-build", () => {
    expect(parseArgs(["extension", "build", "x", "--wait"]).wait).toBe(true);
    expect(parseArgs(["extension", "push", "d"]).build).toBe(true);
    expect(parseArgs(["extension", "push", "d", "--no-build"]).build).toBe(false);
  });

  it("reads the value flags", () => {
    const parsed = parseArgs([
      "devices", "--url", "http://other:2300", "--email", "b@example.com", "--screens", "../screens",
      "--out", "e.zip", "--template", "http://x/api", "--headers", "{}", "--verb", "post", "--exchange", "3",
    ]);
    expect(parsed.url).toBe("http://other:2300");
    expect(parsed.email).toBe("b@example.com");
    expect(parsed.screens).toBe("../screens");
    expect(parsed.out).toBe("e.zip");
    expect(parsed.template).toBe("http://x/api");
    expect(parsed.verb).toBe("post");
    expect(parsed.exchange).toBe("3");
  });

  it("rejects a dangling value flag and an unknown option, rather than reading either as a command", () => {
    expect(() => parseArgs(["devices", "--url"])).toThrow(/--url needs a value/);
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
  it("prints a failing response body verbatim, and a plain message otherwise", () => {
    const error = new TerminusError("PUT", "/extensions/1", 422, '{"errors":{"name":["is missing"]}}');
    expect(errorReport(error)).toBe('PUT /extensions/1 -> HTTP 422\n{"errors":{"name":["is missing"]}}');
    expect(errorReport(new Error("boom"))).toBe("boom");
  });
});
