/**
 * Response shapes for Terminus's JSON API, transcribed from the serializers in
 * `app/serializers/` of Terminus 0.72.0 and checked against live responses.
 *
 * These are observations, not a design: they say what the server sends today, so the first thing
 * built on top of them does not have to re-derive it. Nullability follows what the serializers can
 * actually emit. Timestamps are ISO 8601 strings with an offset (`Transformers::Time`).
 *
 * Terminus is pre-1.0 and says breaking changes will happen, so re-check these after an upgrade —
 * `docker exec terminus-web-1 cat /app/doc/api.adoc` diffs cleanly against a pinned copy.
 */

/** Every collection endpoint wraps its payload in a `data` key. */
export interface Envelope<T> {
  data: T;
}

/** `GET /api/devices`, `GET /api/devices/:id` — Serializers::Device. */
export interface Device {
  id: number;
  model_id: number;
  playlist_id: number;
  label: string;
  mac_address: string;
  /** The device's own firmware credential. Treat as a secret; never log it. */
  api_key: string;
  firmware_profile: boolean;
  firmware_update: boolean;
  firmware_reset: boolean;
  firmware_version: string | null;
  wifi_band: number | null;
  wifi_signal: number | null;
  battery_charge: number | null;
  battery_voltage: number | null;
  charging: boolean;
  refresh_rate: number;
  image_cached: boolean;
  image_timeout: number;
  wake_reason: string | null;
  wake_duration: number | null;
  width: number;
  height: number;
  display_compatibility: boolean;
  display_profile: string;
  command: string;
  touch_bar: string;
  sleep_start_at: string | null;
  sleep_stop_at: string | null;
  /** Last time the device called `/api/display`. Null until it has ever checked in. */
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/screens` — Serializers::Screen. The image half of the record is present only once a
 * screen has been rendered, and the serializer omits all seven keys together when it has not.
 *
 * Note what is *not* here: `extension_id`. A screen built from an extension is named
 * `extension-<extension name>` (Structs::Extension#screen_attributes), and that convention is the
 * only link back.
 */
export interface Screen {
  id: number;
  model_id: number;
  label: string;
  name: string;
  created_at: string;
  updated_at: string;
  filename?: string;
  mime_type?: string;
  bit_depth?: number;
  width?: number;
  height?: number;
  size?: number;
  /** Path, not a URL — join it to the server's base (e.g. `/uploads/<hash>.png`). */
  uri?: string;
}

/** `GET /api/playlists` — Serializers::PlaylistItem. */
export interface PlaylistItem {
  id: number;
  screen_id: number;
  position: number;
  created_at: string;
  updated_at: string;
}

/**
 * `GET /api/playlists`, `GET /api/playlists/:id` — Serializers::Playlist.
 *
 * `items` is what the API exposes; the underlying `playlist_item` row also carries `repeat_type`,
 * `repeat_days`, `repeat_interval`, `start_at`, `stop_at` and `hidden_at`, which 0.72.0 exposes
 * through neither the API nor the web form. Sending an `items` key to `PATCH /api/playlists/:id`
 * deletes and recreates every item and drops all of those. See
 * docs/research/terminus-cli.md.
 */
export interface Playlist {
  id: number;
  name: string;
  label: string;
  current_item_id: number | null;
  mode: string;
  created_at: string;
  updated_at: string;
  items: PlaylistItem[];
}

/** `POST /login` with a JSON body. The access token is a 30-minute HS256 JWT by default. */
export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  success: string;
}

/** Errors use RFC API Problem (`application/problem+json`), with a Terminus `errors` extension. */
export interface ProblemDetails {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, unknown>;
}
