import { describe, expect, it } from "vitest";
import { bytes, orDash, shortTime, table } from "./format.ts";

describe("table", () => {
  it("pads every column to its widest cell and does not pad the last one", () => {
    const rendered = table(
      ["ID", "NAME"],
      [
        ["1", "welcome"],
        ["10", "extension-weather"],
      ],
    );
    expect(rendered).toBe(["ID  NAME", "1   welcome", "10  extension-weather"].join("\n"));
  });

  it("widens a column to fit its header", () => {
    expect(table(["LABEL"], [["x"]])).toBe("LABEL\nx");
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
