/** `terminus screens` — list rendered screens and where their PNGs live. */

import type { TerminusClient } from "../client.ts";
import { bytes, orDash, print, shortTime, table } from "../format.ts";
import type { Envelope, Screen } from "../types.ts";

/**
 * `Serializers::Screen` omits the whole image half of the record until a screen has been
 * rendered, and `uri` is a path rather than a URL, so it is joined to the server base here to
 * give something that can be pasted into a browser or curled.
 */
export function screenUrl(baseUrl: string, screen: Screen): string | null {
  return screen.uri ? `${baseUrl.replace(/\/$/, "")}${screen.uri}` : null;
}

export async function screens(client: TerminusClient, asJson: boolean): Promise<void> {
  const response = await client.json<Envelope<Screen[]>>("GET", "/api/screens");
  // The API returns them in no particular order; id is the stable one to sort on.
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
