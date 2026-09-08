export interface Envelope<T> {
  data: T;
}

export interface Device {
  id: number;
  model_id: number;
  playlist_id: number;
  label: string;
  mac_address: string;
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
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

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
  uri?: string;
}

export interface PlaylistItem {
  id: number;
  screen_id: number;
  position: number;
  created_at: string;
  updated_at: string;
}

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

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  success: string;
}

export interface ProblemDetails {
  type?: string;
  title?: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Record<string, unknown>;
}
