import type { TerminusClient } from "../client.ts";
import { bytes, orDash, print, shortTime, table } from "../format.ts";
import type { Envelope, Screen } from "../types.ts";

export function screenUrl(baseUrl: string, screen: Screen): string | null {
  return screen.uri ? `${baseUrl.replace(/\/$/, "")}${screen.uri}` : null;
}

export async function screens(client: TerminusClient, asJson: boolean): Promise<void> {
  const response = await client.json<Envelope<Screen[]>>("GET", "/api/screens");
  const rows = [...response.data].sort((a, b) => a.id - b.id);

  print(
    rows.map((screen) => ({ ...screen, url: screenUrl(client.url, screen) })),
    asJson,
    () =>
      table(
        ["ID", "NAME", "LABEL", "SIZE", "DEPTH", "BYTES", "UPDATED AT", "URL"],
        rows.map((screen) => [
          String(screen.id),
          screen.name,
          screen.label,
          screen.width && screen.height ? `${screen.width}x${screen.height}` : "-",
          screen.bit_depth === undefined ? "-" : `${screen.bit_depth}-bit`,
          bytes(screen.size),
          shortTime(screen.updated_at),
          orDash(screenUrl(client.url, screen)),
        ]),
        "No screens.",
      ),
  );
}
