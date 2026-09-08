/**
 * `terminus-cli.json` — per-project settings, found by walking up from the working directory.
 *
 * The point of the file is not that it holds settings; environment variables already do that. The
 * point is that it is an *anchor*. Paths inside it resolve relative to the file itself, so
 * `"screens": "screens"` always means the screens directory of the project the file sits in —
 * from a subdirectory, from a scheduled job with no meaningful cwd, from anywhere. A bare
 * `./screens` relative to the shell's cwd would instead quietly pick up whatever folder of that
 * name happened to be underfoot, and `ext push` sends what it reads to a live display.
 *
 * JSON rather than TOML so the CLI keeps its zero runtime dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const CONFIG_FILENAME = "terminus-cli.json";

/** Everything the file may set. Every key is optional; the file itself is optional. */
const KNOWN_KEYS = ["url", "email", "password_ref", "screens"] as const;

export interface Config {
  /** Absolute path of the file this came from, or null when no file was found. */
  file: string | null;
  url: string | undefined;
  email: string | undefined;
  /** An `op://` reference. The password itself is never allowed in the file. */
  passwordRef: string | undefined;
  /** Absolute, resolved against the config file's own directory. */
  screensDir: string | undefined;
}

export const EMPTY_CONFIG: Config = {
  file: null,
  url: undefined,
  email: undefined,
  passwordRef: undefined,
  screensDir: undefined,
};

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

/**
 * Validate and resolve one config file's contents.
 *
 * Unknown keys are an error rather than being ignored: a typo like `"screen"` that silently does
 * nothing would leave the CLI falling back to a default the author thought they had overridden,
 * which is the failure this file exists to prevent.
 */
export function parseConfig(text: string, file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(file, `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(file, "expected a JSON object.");
  }

  const body = raw as Record<string, unknown>;

  // This file gets committed to whichever repo it configures, so a literal password must not be
  // possible to write into it even by accident. References only.
  if ("password" in body) {
    fail(file, `must not contain a password. Use "password_ref" with an op:// reference instead.`);
  }

  const unknown = Object.keys(body).filter((key) => !(KNOWN_KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    fail(file, `unknown key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Known keys: ${KNOWN_KEYS.join(", ")}.`);
  }

  for (const key of KNOWN_KEYS) {
    const value = body[key];
    if (value !== undefined && (typeof value !== "string" || value === "")) {
      fail(file, `"${key}" must be a non-empty string.`);
    }
  }

  const screens = body.screens as string | undefined;
  return {
    file,
    url: body.url as string | undefined,
    email: body.email as string | undefined,
    passwordRef: body.password_ref as string | undefined,
    // Relative to the file, which is the whole reason the file is worth having.
    screensDir: screens === undefined ? undefined : resolve(dirname(file), screens),
  };
}

/** The nearest `terminus-cli.json` at or above `startDir`, or null. */
export function findConfigFile(startDir: string): string | null {
  let directory = resolve(startDir);
  for (;;) {
    const candidate = resolve(directory, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function loadConfig(startDir: string = process.cwd()): Config {
  const file = findConfigFile(startDir);
  if (!file) return EMPTY_CONFIG;
  return parseConfig(readFileSync(file, "utf8"), file);
}

export interface Flags {
  url: string | undefined;
  email: string | undefined;
  screens: string | undefined;
}

/** Where a setting came from: a flag, an environment variable, or the config file. */
export type Source = string | null;

export interface Settings {
  url: string | undefined;
  email: string | undefined;
  passwordRef: string | undefined;
  screensDir: string | undefined;
  configFile: string | null;
  /**
   * Which source supplied each setting, for `terminus config` to report. `password` names the
   * source without ever carrying the secret: when it is `TERMINUS_PASSWORD` the password is a
   * literal in the environment, and `passwordRef` is undefined.
   */
  sources: {
    url: Source;
    email: Source;
    password: Source;
    screens: Source;
  };
}

/** The first candidate that has a value, with the name of where it came from. */
function pick(candidates: [string | undefined, string][]): [string | undefined, Source] {
  for (const [value, source] of candidates) {
    if (value !== undefined) return [value, source];
  }
  return [undefined, null];
}

/**
 * Settle every setting: an explicit flag wins, then the environment, then the config file.
 *
 * A flag or environment path is relative to the working directory, because that is what someone
 * typing it means. A config path is already resolved against the config file.
 */
export function resolveSettings(
  flags: Flags,
  env: NodeJS.ProcessEnv,
  config: Config,
  cwd: string = process.cwd(),
): Settings {
  // An empty variable is unset. `FOO=` in a shell profile must not shadow the config file.
  const envValue = (name: string): string | undefined => env[name] || undefined;
  const fromCwd = (path: string | undefined): string | undefined =>
    path === undefined ? undefined : isAbsolute(path) ? path : resolve(cwd, path);

  const [url, urlSource] = pick([
    [flags.url, "--url"],
    [envValue("TERMINUS_URL"), "TERMINUS_URL"],
    [config.url, CONFIG_FILENAME],
  ]);
  const [email, emailSource] = pick([
    [flags.email, "--email"],
    [envValue("TERMINUS_EMAIL"), "TERMINUS_EMAIL"],
    [config.email, CONFIG_FILENAME],
  ]);
  const [screensDir, screensSource] = pick([
    [fromCwd(flags.screens), "--screens"],
    [fromCwd(envValue("TERMINUS_SCREENS_DIR")), "TERMINUS_SCREENS_DIR"],
    [config.screensDir, CONFIG_FILENAME],
  ]);
  const [passwordRef, refSource] = pick([
    [envValue("TERMINUS_PASSWORD_REF"), "TERMINUS_PASSWORD_REF"],
    [config.passwordRef, CONFIG_FILENAME],
  ]);

  // A literal password beats any reference; `resolvePassword` applies the same rule, and the test
  // suite pins the two together so they cannot drift.
  const literal = env.TERMINUS_PASSWORD ? "TERMINUS_PASSWORD" : null;

  return {
    url,
    email,
    passwordRef: literal ? undefined : passwordRef,
    screensDir,
    configFile: config.file,
    sources: {
      url: urlSource,
      email: emailSource,
      password: literal ?? refSource,
      screens: screensSource,
    },
  };
}
