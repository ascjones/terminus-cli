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
    });
  });

  it("reads the value flags", () => {
    const parsed = parseArgs(["devices", "--url", "http://other:2300", "--email", "b@example.com"]);
    expect(parsed.url).toBe("http://other:2300");
    expect(parsed.email).toBe("b@example.com");
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
