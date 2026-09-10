import { existsSync, readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import type { TerminusClient, FormFields } from "./client.ts";

export const REDACTED = "[redacted]";

export interface ExtensionCard {
  id: number;
  name: string;
  label: string;
  kind: string;
}

export interface BuildMatrix {
  device_ids: string[];
  model_ids: string[];
}

export interface ExchangeState {
  id: number;
  template: string;
  verb: string;
  headers: Record<string, unknown>;
  body: string;
  errors: Record<string, unknown>;
  has_data: boolean;
}

export interface Configuration {
  name: string;
  label: string;
  description: string;
  kind: string;
  mode: string | null;
  tags: string | null;
  static_body: string | null;
  fields: string | null;
  data: string | null;
  interval: string | null;
  unit: string | null;
  days: string[];
  last_day_of_month: boolean;
  start_at: string;
  exchanges: { template: string; verb: string; headers: Record<string, unknown>; body: unknown }[];
}

export interface ExtensionSource {
  configuration: Configuration;
  template: string;
}

const CARD = /<li id="(\d+)" class="bit-card extension">([\s\S]*?)<\/li>/g;

export function parseExtensionIndex(html: string): ExtensionCard[] {
  const cards: ExtensionCard[] = [];
  for (const match of html.matchAll(CARD)) {
    const id = Number(match[1]);
    const body = match[2] ?? "";
    const name = /download="extension-([^"]+)\.zip"/.exec(body)?.[1];
    const label = /<h2 class="label">([^<]*)<\/h2>/.exec(body)?.[1];
    if (!name || label === undefined) continue;
    cards.push({ id, name, label, kind: /<span>([^<]*)<\/span>/.exec(body)?.[1] ?? "" });
  }
  if (cards.length === 0 && /class="bit-card extension"/.test(html)) {
    throw new Error("Could not read the extension list. The markup this CLI scrapes may have changed.");
  }
  return cards;
}

export function parseBuildMatrix(html: string): BuildMatrix {
  const selected = (field: string): string[] => {
    const block = new RegExp(`name="extension\\[${field}\\]\\[\\]"([\\s\\S]*?)</select>`).exec(html);
    if (!block) return [];
    return [...(block[1] ?? "").matchAll(/<option value="(\d+)" selected="selected"/g)].map((m) => m[1] ?? "");
  };
  return { device_ids: selected("device_ids"), model_ids: selected("model_ids") };
}

export function parseExchangeIds(html: string, extensionId: number): number[] {
  const pattern = new RegExp(`href="/extensions/${extensionId}/exchanges/(\\d+)/edit"`, "g");
  return [...new Set([...html.matchAll(pattern)].map((m) => Number(m[1])))];
}

function textarea(html: string, selector: string): string {
  const match = new RegExp(`<textarea[^>]*${selector}[^>]*>\\n?([\\s\\S]*?)</textarea>`).exec(html);
  return decodeEntities(match?.[1] ?? "").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function parseExchangeForm(html: string, id: number): ExchangeState {
  const data = textarea(html, 'id="exchange_data"');
  return {
    id,
    template: textarea(html, 'name="exchange\\[template\\]"'),
    verb: /name="exchange\[verb\]"[^>]*value="([^"]*)"[^>]*checked/.exec(html)?.[1] ?? "get",
    headers: parseJsonObject(textarea(html, 'name="exchange\\[headers\\]"')),
    body: textarea(html, 'name="exchange\\[body\\]"'),
    errors: parseJsonObject(textarea(html, 'id="exchange_errors"')),
    has_data: data !== "" && data !== "{}",
  };
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /^(authorization|cookie|x-api-key|api-key|token)$/i.test(key) ? REDACTED : value;
  }
  return out;
}

function requireString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${where}: "${field}" is required and must be a non-empty string.`);
  }
  return value;
}

function optionalScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

export function parseConfiguration(text: string, where: string): Configuration {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new Error(`${where}: not valid YAML (${error instanceof Error ? error.message : String(error)})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}: expected a YAML mapping.`);
  }
  const body = raw as Record<string, unknown>;
  const exchanges = Array.isArray(body.exchanges) ? body.exchanges : [];

  return {
    name: requireString(body.name, "name", where),
    label: requireString(body.label, "label", where),
    description: typeof body.description === "string" ? body.description : "",
    kind: requireString(body.kind, "kind", where),
    mode: optionalScalar(body.mode),
    tags: optionalScalar(body.tags),
    static_body: optionalScalar(body.static_body),
    fields: optionalScalar(body.fields),
    data: optionalScalar(body.data),
    interval: optionalScalar(body.interval),
    unit: optionalScalar(body.unit),
    days: Array.isArray(body.days) ? body.days.map(String) : [],
    last_day_of_month: body.last_day_of_month === true,
    start_at: optionalScalar(body.start_at) ?? "",
    exchanges: exchanges.map((entry) => {
      const one = (entry ?? {}) as Record<string, unknown>;
      return {
        template: typeof one.template === "string" ? one.template : "",
        verb: typeof one.verb === "string" ? one.verb : "get",
        headers:
          typeof one.headers === "object" && one.headers !== null
            ? (one.headers as Record<string, unknown>)
            : {},
        body: one.body ?? null,
      };
    }),
  };
}

export function resolveSourcePath(reference: string, screensDir: string | undefined): string {
  if (existsSync(reference)) return reference;
  if (!reference.includes(sep) && !reference.includes("/") && screensDir) {
    for (const candidate of [join(screensDir, reference), join(screensDir, `${reference}.zip`)]) {
      if (existsSync(candidate)) return candidate;
    }
    throw new Error(
      `No extension source "${reference}" here or in ${screensDir}. Pass a path, or set "screens" in terminus-cli.json.`,
    );
  }
  throw new Error(`No extension source at ${reference}.`);
}

export function readExtensionSource(path: string): ExtensionSource {
  if (path.endsWith(".zip")) {
    const entries = unzipSync(new Uint8Array(readFileSync(path)));
    const decoder = new TextDecoder();
    const pick = (suffix: string): string | undefined => {
      const key = Object.keys(entries).find((name) => name.endsWith(suffix));
      const bytes = key === undefined ? undefined : entries[key];
      return bytes === undefined ? undefined : decoder.decode(bytes);
    };
    const configuration = pick("configuration.yml");
    const template = pick("template.html.liquid");
    if (configuration === undefined || template === undefined) {
      throw new Error(`${basename(path)}: expected configuration.yml and template.html.liquid inside the zip.`);
    }
    return { configuration: parseConfiguration(configuration, `${basename(path)}/configuration.yml`), template };
  }

  const configurationPath = join(path, "configuration.yml");
  const templatePath = join(path, "template.html.liquid");
  return {
    configuration: parseConfiguration(readFileSync(configurationPath, "utf8"), configurationPath),
    template: readFileSync(templatePath, "utf8"),
  };
}

export function extensionFields(source: ExtensionSource, matrix: BuildMatrix): FormFields {
  const fields: FormFields = {
    "extension[name]": source.configuration.name,
    "extension[label]": source.configuration.label,
    "extension[description]": source.configuration.description,
    "extension[kind]": source.configuration.kind,
    "extension[tags]": source.configuration.tags ?? "",
    "extension[static_body]": source.configuration.static_body ?? "",
    "extension[fields]": source.configuration.fields ?? "",
    "extension[data]": source.configuration.data ?? "",
    "extension[interval]": source.configuration.interval ?? "",
    "extension[last_day_of_month]": String(source.configuration.last_day_of_month),
    "extension[start_at]": source.configuration.start_at,
    "extension[template]": source.template,
    "extension[device_ids][]": matrix.device_ids,
    "extension[model_ids][]": matrix.model_ids,
  };
  if (source.configuration.mode !== null) fields["extension[mode]"] = source.configuration.mode;
  if (source.configuration.unit !== null) fields["extension[unit]"] = source.configuration.unit;
  if (source.configuration.days.length > 0) fields["extension[days][]"] = source.configuration.days;
  return fields;
}

export async function listExtensions(client: TerminusClient): Promise<ExtensionCard[]> {
  return parseExtensionIndex(await client.html("/extensions"));
}

export async function resolveExtension(client: TerminusClient, reference: string): Promise<ExtensionCard> {
  const cards = await listExtensions(client);
  const match = /^\d+$/.test(reference)
    ? cards.find((card) => card.id === Number(reference))
    : cards.find((card) => card.name === reference);
  if (!match) {
    const known = cards.map((card) => `${card.id} ${card.name}`).join(", ") || "none";
    throw new Error(`No extension matching "${reference}". Known: ${known}.`);
  }
  return match;
}

export async function readExchanges(client: TerminusClient, extensionId: number): Promise<ExchangeState[]> {
  const ids = parseExchangeIds(await client.html(`/extensions/${extensionId}/exchanges`), extensionId);
  const states: ExchangeState[] = [];
  for (const id of ids) {
    states.push(parseExchangeForm(await client.html(`/extensions/${extensionId}/exchanges/${id}/edit`), id));
  }
  return states;
}

export async function readBuildMatrix(client: TerminusClient, extensionId: number): Promise<BuildMatrix> {
  return parseBuildMatrix(await client.html(`/extensions/${extensionId}/edit`));
}

export async function exportExtension(client: TerminusClient, extensionId: number): Promise<Uint8Array> {
  const response = await client.request("GET", `/extensions/${extensionId}/export`, {
    method: "GET",
    redirect: "manual",
  });
  if (!response.ok) {
    throw new Error(`GET /extensions/${extensionId}/export -> HTTP ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}
