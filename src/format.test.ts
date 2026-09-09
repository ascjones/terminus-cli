import { describe, expect, it } from "vitest";
import { bytes, orDash, shortTime, table } from "./format.ts";

describe("table", () => {
  it("pads each column to its widest cell or its header, and never the last one", () => {
    const rendered = table(
      ["ID", "LABEL", "NAME"],
      [
        ["1", "x", "welcome"],
        ["10", "yy", "extension-weather"],
      ],
    );
    expect(rendered).toBe(
      ["ID  LABEL  NAME", "1   x      welcome", "10  yy     extension-weather"].join("\n"),
    );
  });

  it("renders the empty note instead of a bare header row", () => {
    expect(table(["ID"], [], "No devices.")).toBe("No devices.");
  });
});

describe("value formatters", () => {
  it("shows a dash for what the server left null or omitted", () => {
    expect(orDash(null)).toBe("-");
    expect(orDash(undefined)).toBe("-");
    expect(orDash(0)).toBe("0");
    expect(shortTime(null)).toBe("-");
    expect(bytes(undefined)).toBe("-");
  });

  it("trims timestamps to minutes without losing the offset", () => {
    expect(shortTime("2026-09-07T14:25:33+00:00")).toBe("2026-09-07 14:25+00:00");
  });

  it("rounds byte counts above a kilobyte", () => {
    expect(bytes(512)).toBe("512 B");
    expect(bytes(58411)).toBe("57.0 KB");
  });
});
