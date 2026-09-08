import { describe, expect, it } from "vitest";
import { redact } from "./devices.ts";
import { resolvePlaylist } from "./playlist.ts";
import { screenUrl } from "./screens.ts";
import type { Device, Playlist, Screen } from "../types.ts";

const device = { id: 2, label: "TRMNL", api_key: "sk-not-a-real-key-000000000000" } as unknown as Device;

const screens = [
  { id: 3, name: "extension-weather", label: "Extension Weather" },
  { id: 4, name: "extension-calendar", label: "Extension Calendar" },
] as unknown as Screen[];

describe("redact", () => {
  it("removes the device's firmware credential and keeps everything else", () => {
    const redacted = redact(device);
    expect(redacted.api_key).toBe("[redacted]");
    expect(JSON.stringify(redacted)).not.toContain("sk-not-a-real-key-000000000000");
    expect(redacted.label).toBe("TRMNL");
  });
});

describe("screenUrl", () => {
  it("joins the uri path to the server base", () => {
    expect(screenUrl("http://localhost:2300/", { uri: "/uploads/a.png" } as Screen)).toBe(
      "http://localhost:2300/uploads/a.png",
    );
  });

  it("is null for a screen that has never been rendered", () => {
    expect(screenUrl("http://localhost:2300", {} as Screen)).toBeNull();
  });
});

describe("resolvePlaylist", () => {
  const playlist = {
    id: 2,
    name: "device_2",
    label: "Device 2",
    mode: "automatic",
    current_item_id: 3,
    items: [
      { id: 4, screen_id: 4, position: 3, updated_at: "2026-09-07T14:21:00+00:00" },
      { id: 3, screen_id: 3, position: 2, updated_at: "2026-09-07T14:11:00+00:00" },
    ],
  } as unknown as Playlist;

  it("orders by position and marks the current item", () => {
    const resolved = resolvePlaylist(playlist, screens);
    expect(resolved.items.map((item) => item.id)).toEqual([3, 4]);
    expect(resolved.items.map((item) => item.current)).toEqual([true, false]);
    expect(resolved.items[0]?.screen_name).toBe("extension-weather");
  });

  it("reports an item whose screen is gone rather than dropping it", () => {
    const resolved = resolvePlaylist(playlist, [screens[0] as Screen]);
    expect(resolved.items).toHaveLength(2);
    expect(resolved.items[1]?.screen_name).toBeNull();
  });
});
