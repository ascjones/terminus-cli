/**
 * `terminus config` — what the CLI resolved, and where each value came from.
 *
 * The answer to "why is it talking to the wrong server?" once a flag, the environment and a
 * config file can all supply one. It reports sources rather than just values, and it makes no
 * network request: this is about the CLI's own state, not the server's.
 */

import { CONFIG_FILENAME, type Settings } from "../config.ts";
import { orDash, print, table } from "../format.ts";

/** What `--json` emits and the table renders. `password` never carries the secret. */
export interface ConfigReport {
  config_file: string | null;
  settings: {
    url: { value: string | null; source: string | null };
    email: { value: string | null; source: string | null };
    password: { value: string | null; source: string | null };
    screens: { value: string | null; source: string | null };
  };
}

export function report(settings: Settings): ConfigReport {
  return {
    config_file: settings.configFile,
    settings: {
      url: { value: settings.url ?? null, source: settings.sources.url },
      email: { value: settings.email ?? null, source: settings.sources.email },
      // A reference is a pointer and safe to show; a literal password is never read here at all,
      // so the value stays null and only the source names where it would come from.
      password: { value: settings.passwordRef ?? null, source: settings.sources.password },
      screens: { value: settings.screensDir ?? null, source: settings.sources.screens },
    },
  };
}

export function configCommand(settings: Settings, asJson: boolean): void {
  const rendered = report(settings);

  print(rendered, asJson, () => {
    const rows = Object.entries(rendered.settings).map(([name, { value, source }]) => [
      name,
      value === null && source !== null ? "(set, not shown)" : orDash(value),
      orDash(source),
    ]);
    const header = `${CONFIG_FILENAME}  ${rendered.config_file ?? "(none found)"}`;
    return `${header}\n${table(["SETTING", "VALUE", "FROM"], rows)}`;
  });
}
