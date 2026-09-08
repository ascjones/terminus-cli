/** `terminus devices` — list the devices this server knows about. */

import type { TerminusClient } from "../client.ts";
import { orDash, print, shortTime, table } from "../format.ts";
import type { Device, Envelope } from "../types.ts";

/**
 * A device record with its firmware credential removed.
 *
 * `Serializers::Device` exposes `api_key`, which is the secret the panel authenticates with. It
 * must not reach stdout, a log or a pipeline, so it is redacted before anything is printed —
 * including in `--json` mode, where it would otherwise be the easiest thing in the world to
 * accidentally commit.
 */
export type RedactedDevice = Omit<Device, "api_key"> & { api_key: "[redacted]" };

export function redact(device: Device): RedactedDevice {
  return { ...device, api_key: "[redacted]" };
}

export async function devices(client: TerminusClient, asJson: boolean): Promise<void> {
  const response = await client.json<Envelope<Device[]>>("GET", "/api/devices");
  const rows = response.data.map(redact);

  print(rows, asJson, () =>
    table(
      ["ID", "LABEL", "MAC", "MODEL", "PLAYLIST", "FIRMWARE", "REFRESH", "BATTERY", "WIFI", "SIZE", "SYNCED AT"],
      rows.map((device) => [
        String(device.id),
        device.label,
        device.mac_address,
        String(device.model_id),
        String(device.playlist_id),
        orDash(device.firmware_version),
        `${device.refresh_rate}s`,
        device.battery_charge === null ? "-" : `${Math.round(device.battery_charge)}%`,
        device.wifi_signal === null ? "-" : `${device.wifi_signal} dBm`,
        `${device.width}x${device.height}`,
        shortTime(device.synced_at),
      ]),
      "No devices.",
    ),
  );
}
