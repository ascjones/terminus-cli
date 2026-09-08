import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const CONFIG_FILENAME = "terminus-cli.json";

const KNOWN_KEYS = ["url", "email", "password_ref", "screens"] as const;

export interface Config {
  file: string | null;
  url: string | undefined;
  email: string | undefined;
  passwordRef: string | undefined;
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
    screensDir: screens === undefined ? undefined : resolve(dirname(file), screens),
  };
}

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

export type Source = string | null;

export interface Settings {
  url: string | undefined;
  email: string | undefined;
  passwordRef: string | undefined;
  screensDir: string | undefined;
  configFile: string | null;
  sources: {
    url: Source;
    email: Source;
    password: Source;
    screens: Source;
  };
}

function pick(candidates: [string | undefined, string][]): [string | undefined, Source] {
  for (const [value, source] of candidates) {
    if (value !== undefined) return [value, source];
  }
  return [undefined, null];
}

export function resolveSettings(
  flags: Flags,
  env: NodeJS.ProcessEnv,
  config: Config,
  cwd: string = process.cwd(),
): Settings {
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
