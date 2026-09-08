import type { TerminusClient } from "../client.ts";
import { print, shortTime, table } from "../format.ts";
import type { Envelope, Playlist, Screen } from "../types.ts";

export interface ResolvedItem {
  id: number;
  position: number;
  screen_id: number;
  screen_name: string | null;
  screen_label: string | null;
  current: boolean;
  updated_at: string;
}

export interface ResolvedPlaylist {
  id: number;
  name: string;
  label: string;
  mode: string;
  current_item_id: number | null;
  items: ResolvedItem[];
}

export function resolvePlaylist(playlist: Playlist, screens: Screen[]): ResolvedPlaylist {
  const byId = new Map(screens.map((screen) => [screen.id, screen]));
  return {
    id: playlist.id,
    name: playlist.name,
    label: playlist.label,
    mode: playlist.mode,
    current_item_id: playlist.current_item_id,
    items: [...playlist.items]
      .sort((a, b) => a.position - b.position)
      .map((item) => {
        const screen = byId.get(item.screen_id);
        return {
          id: item.id,
          position: item.position,
          screen_id: item.screen_id,
          screen_name: screen?.name ?? null,
          screen_label: screen?.label ?? null,
          current: item.id === playlist.current_item_id,
          updated_at: item.updated_at,
        };
      }),
  };
}

function render(playlist: ResolvedPlaylist): string {
  const header =
    `playlist ${playlist.id}  ${playlist.name}  "${playlist.label}"  ` +
    `mode=${playlist.mode}  current_item=${playlist.current_item_id ?? "-"}`;
  const rows = playlist.items.map((item) => [
    item.current ? "*" : "",
    String(item.id),
    String(item.position),
    String(item.screen_id),
    item.screen_name ?? "(missing screen)",
    item.screen_label ?? "-",
    shortTime(item.updated_at),
  ]);
  return `${header}\n${table(["", "ITEM", "POS", "SCREEN", "NAME", "LABEL", "UPDATED AT"], rows, "  (no items)")}`;
}

export async function playlistShow(
  client: TerminusClient,
  id: number | null,
  asJson: boolean,
): Promise<void> {
  const [playlists, screens] = await Promise.all([
    id === null
      ? client
          .json<Envelope<Playlist[]>>("GET", "/api/playlists")
          .then((response) => [...response.data].sort((a, b) => a.id - b.id))
      : client.json<Envelope<Playlist>>("GET", `/api/playlists/${id}`).then((r) => [r.data]),
    client.json<Envelope<Screen[]>>("GET", "/api/screens").then((response) => response.data),
  ]);

  const resolved = playlists.map((playlist) => resolvePlaylist(playlist, screens));
  print(id === null ? resolved : resolved[0], asJson, () =>
    resolved.length === 0 ? "No playlists." : resolved.map(render).join("\n\n"),
  );
}
