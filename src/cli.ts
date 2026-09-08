/**
 * Argument parsing and command dispatch. `scripts/terminus.ts` is the thin entry point that
 * calls `run` and turns a thrown error into an exit status.
 */

import { TerminusClient, TerminusError } from "./client.ts";
import { devices } from "./commands/devices.ts";
import { playlistShow } from "./commands/playlist.ts";
import { screens } from "./commands/screens.ts";

export const USAGE = `terminus — drive a self-hosted Terminus server

Usage: npm run terminus -- <command> [options]

Commands
  devices                  list devices: label, model, firmware, refresh, battery, synced_at
  screens                  list screens: size, bytes, updated_at and the URL of the rendered PNG
  playlist show [<id>]     playlist items in order, and which one is current

Options
  --json                   machine-readable output (available on every command)
  --url <url>              server base URL (default: $TERMINUS_URL)
  --email <address>        account to log in as (default: $TERMINUS_EMAIL)
  --verbose                log each request's method, path and status to stderr
  -h, --help               this text

Environment
  TERMINUS_URL             e.g. http://localhost:2300
  TERMINUS_EMAIL           account email
  TERMINUS_PASSWORD_REF    an op:// reference, resolved with \`op read\` when a login is needed
  TERMINUS_PASSWORD        fallback for CI or a machine without the 1Password CLI

A device's api_key is redacted from all output, including --json.`;

export interface ParsedArgs {
  command: string[];
  json: boolean;
  verbose: boolean;
  help: boolean;
  url?: string;
  email?: string;
}

/** A flag that takes a value; everything else is either a boolean flag or a positional. */
const VALUE_FLAGS = new Set(["--url", "--email"]);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: [], json: false, verbose: false, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} needs a value.`);
      if (arg === "--url") parsed.url = value;
      else parsed.email = value;
      index += 1;
    } else if (arg === "--json") parsed.json = true;
    else if (arg === "--verbose") parsed.verbose = true;
    else if (arg === "-h" || arg === "--help") parsed.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}. Try --help.`);
    else parsed.command.push(arg);
  }

  return parsed;
}

/** Parse a positional that must be a playlist id, or null when it was not given. */
export function optionalId(value: string | undefined, what: string): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new Error(`Expected a numeric ${what}, got "${value}".`);
  return Number(value);
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.help || args.command.length === 0) {
    process.stdout.write(`${USAGE}\n`);
    return args.command.length === 0 && !args.help ? 1 : 0;
  }

  const client = TerminusClient.fromEnv({
    ...(args.url === undefined ? {} : { url: args.url }),
    ...(args.email === undefined ? {} : { email: args.email }),
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
    default:
      throw new Error(`Unknown command "${command}". Try --help.`);
  }
}

/** Turn any thrown error into the message that should reach stderr. */
export function errorReport(error: unknown): string {
  if (error instanceof TerminusError) return error.report;
  if (error instanceof Error) return error.message;
  return String(error);
}
