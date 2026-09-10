import { TerminusClient, TerminusError, resolvePassword } from "./client.ts";
import { CONFIG_FILENAME, loadConfig, resolveSettings } from "./config.ts";
import { configCommand } from "./commands/config.ts";
import { devices } from "./commands/devices.ts";
import {
  type ExtensionFlags,
  extensionBuild,
  extensionExchangeSet,
  extensionExport,
  extensionList,
  extensionPush,
  extensionShow,
} from "./commands/extension.ts";
import { playlistShow } from "./commands/playlist.ts";
import { screens } from "./commands/screens.ts";

export const USAGE = `terminus — drive a self-hosted Terminus server

Usage: npm run terminus -- <command> [options]

Commands
  config                   the resolved settings, and which source each one came from
  devices                  list devices: label, model, firmware, refresh, battery, synced_at
  screens                  list screens: size, bytes, updated_at and the URL of the rendered PNG
  playlist show [<id>]     playlist items in order, and which one is current

  extension list                       id, name, label, kind
  extension show <id|name>             build matrix, exchange URLs, data and errors
  extension export <id|name>           download the zip (--out FILE)
  extension exchange set <id|name>     --template URL [--headers JSON] [--verb get|post]
                                       [--exchange <id>]; prints errors after the save
  extension build <id|name> [--wait]   enqueue a build; --wait polls for the new screen
  extension push <dir|zip> [--no-build]
                                       update in place by name, keeping the build matrix,
                                       or import it when the name is new

Options
  --json                   machine-readable output (available on every command)
  --url <url>              server base URL
  --email <address>        account to log in as
  --screens <dir>          where extension push <name> looks for a source directory or zip
  --verbose                log each request's method, path and status to stderr
  -h, --help               this text

Settings are taken from a flag first, then the environment, then the nearest ${CONFIG_FILENAME}
found by walking up from the working directory. Paths in that file resolve against the file itself,
so they mean the same thing from any directory:

  {
    "url": "http://localhost:2300",
    "email": "you@example.com",
    "screens": "screens"
  }

Environment
  TERMINUS_URL             e.g. http://localhost:2300
  TERMINUS_EMAIL           account email
  TERMINUS_PASSWORD        the password; resolve it in your shell if it lives in a secret store
  TERMINUS_SCREENS_DIR     as --screens

A device's api_key is redacted from all output, including --json.`;

export interface ParsedArgs {
  command: string[];
  json: boolean;
  verbose: boolean;
  help: boolean;
  url?: string;
  email?: string;
  screens?: string;
  out?: string;
  template?: string;
  headers?: string;
  verb?: string;
  exchange?: string;
  wait: boolean;
  build: boolean;
}

const VALUE_FLAGS = new Set(["--url", "--email", "--screens", "--out", "--template", "--headers", "--verb", "--exchange"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: [], json: false, verbose: false, help: false, wait: false, build: true };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      if (arg === "--url") parsed.url = value;
      else if (arg === "--email") parsed.email = value;
      else if (arg === "--screens") parsed.screens = value;
      else if (arg === "--out") parsed.out = value;
      else if (arg === "--template") parsed.template = value;
      else if (arg === "--headers") parsed.headers = value;
      else if (arg === "--verb") parsed.verb = value;
      else parsed.exchange = value;
      index += 1;
    } else if (arg === "--json") parsed.json = true;
    else if (arg === "--wait") parsed.wait = true;
    else if (arg === "--no-build") parsed.build = false;
    else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. Try --help.`);
    else parsed.command.push(arg);
  }

  return parsed;
}

export function optionalId(value: string | undefined, what: string): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new Error(`Expected a numeric ${what}, got "${value}".`);
  return Number(value);
}

export function requireArg(value: string | undefined, usage: string): string {
  if (value === undefined) throw new Error(`Usage: terminus ${usage}`);
  return value;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || args.command.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return args.command.length === 0 && !args.help ? 1 : 0;
  }

  const settings = resolveSettings(
    { url: args.url, email: args.email, screens: args.screens },
    process.env,
    loadConfig(),
  );
  if (args.verbose && settings.configFile) {
    process.stderr.write(`config ${settings.configFile}\n`);
  }
  if (args.command[0] === "config") {
    configCommand(settings, args.json);
    return 0;
  }

  if (!settings.url) {
    throw new Error(`Set TERMINUS_URL, or "url" in ${CONFIG_FILENAME}, or pass --url.`);
  }
  if (!settings.email) {
    throw new Error(`Set TERMINUS_EMAIL, or "email" in ${CONFIG_FILENAME}, or pass --email.`);
  }

  const client = new TerminusClient({
    url: settings.url,
    email: settings.email,
    password: () => resolvePassword(process.env),
    verbose: args.verbose,
  });

  const [command, ...rest] = args.command;
  switch (command) {
    case "devices":
      await devices(client, args.json);
      return 0;
    case "screens":
      await screens(client, args.json);
      return 0;
    case "playlist": {
      const [subcommand, ...playlistArgs] = rest;
      if (subcommand !== "show") {
        throw new Error(`Unknown playlist subcommand "${subcommand ?? ""}". Only \`show\` exists so far.`);
      }
      await playlistShow(client, optionalId(playlistArgs[0], "playlist id"), args.json);
      return 0;
    }
    case "extension": {
      const flags: ExtensionFlags = {
        out: args.out,
        template: args.template,
        headers: args.headers,
        verb: args.verb,
        exchange: args.exchange,
        wait: args.wait,
        build: args.build,
        screensDir: settings.screensDir,
      };
      const [subcommand, ...extensionArgs] = rest;
      switch (subcommand) {
        case "list":
          await extensionList(client, args.json);
          return 0;
        case "show":
          await extensionShow(client, requireArg(extensionArgs[0], "extension show <id|name>"), args.json);
          return 0;
        case "export":
          await extensionExport(
            client,
            requireArg(extensionArgs[0], "extension export <id|name>"),
            args.out,
            args.json,
          );
          return 0;
        case "build":
          await extensionBuild(client, requireArg(extensionArgs[0], "extension build <id|name>"), flags, args.json);
          return 0;
        case "push":
          await extensionPush(client, requireArg(extensionArgs[0], "extension push <dir|zip>"), flags, args.json);
          return 0;
        case "exchange": {
          if (extensionArgs[0] !== "set") {
            throw new Error(`Unknown exchange subcommand "${extensionArgs[0] ?? ""}". Only \`set\` exists.`);
          }
          await extensionExchangeSet(
            client,
            requireArg(extensionArgs[1], "extension exchange set <id|name>"),
            flags,
            args.json,
          );
          return 0;
        }
        default:
          throw new Error(`Unknown extension subcommand "${subcommand ?? ""}". Try --help.`);
      }
    }
    default:
      throw new Error(`Unknown command "${command}". Try --help.`);
  }
}

export function errorReport(error: unknown): string {
  if (error instanceof TerminusError) return error.report;
  if (error instanceof Error) return error.message;
  return String(error);
}
