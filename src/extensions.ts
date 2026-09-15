import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { unzipSync } from "fflate";
import { parse as parseYaml } from "yaml";
import { TerminusError, type TerminusClient, type FormFields } from "./client.ts";

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
  data_digest: string;
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
  configurationText: string;
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

function scrapeError(what: string): Error {
  return new Error(
    `Could not read ${what}. The markup this CLI scrapes may have changed, so nothing was written.`,
  );
}

export function parseBuildMatrix(html: string): BuildMatrix {
  const selected = (field: string): string[] => {
    const block = new RegExp(`<select[^>]*name="extension\\[${field}\\]\\[\\]"[^>]*>([\\s\\S]*?)</select>`).exec(html);
    if (!block) throw scrapeError(`the ${field} build matrix from the extension edit page`);
    return [...(block[1] ?? "").matchAll(/<option\b([^>]*)>/g)]
      .filter((option) => /(?:^|\s)selected(?:[\s=]|$)/.test(option[1] ?? ""))
      .map((option) => /\bvalue="([^"]*)"/.exec(option[1] ?? "")?.[1])
      .filter((value): value is string => value !== undefined);
  };
  return { device_ids: selected("device_ids"), model_ids: selected("model_ids") };
}

export function parseExchangeIds(html: string, extensionId: number): number[] {
  const pattern = new RegExp(`href="/extensions/${extensionId}/exchanges/(\\d+)/edit"`, "g");
  return [...new Set([...html.matchAll(pattern)].map((m) => Number(m[1])))];
}

function textarea(html: string, selector: string): string | undefined {
  const match = new RegExp(`<textarea[^>]*${selector}[^>]*>\\n?([\\s\\S]*?)</textarea>`).exec(html);
  return match ? decodeEntities(match[1] ?? "").trim() : undefined;
}

function requireTextarea(html: string, selector: string, what: string): string {
  const value = textarea(html, selector);
  if (value === undefined) throw scrapeError(what);
  return value;
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

function parseHeaders(text: string): Record<string, unknown> {
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw scrapeError("the exchange headers");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw scrapeError("the exchange headers");
  }
  return parsed as Record<string, unknown>;
}

export function parseExchangeForm(html: string, id: number): ExchangeState {
  const data = textarea(html, 'id="exchange_data"') ?? "";
  const verb = /x-data="\{\s*verb:\s*'(get|post)'\s*\}"/.exec(html)?.[1];
  if (!verb) throw scrapeError("the exchange verb");
  return {
    id,
    template: requireTextarea(html, 'name="exchange\\[template\\]"', "the exchange URL"),
    verb,
    headers: parseHeaders(requireTextarea(html, 'name="exchange\\[headers\\]"', "the exchange headers")),
    body: requireTextarea(html, 'name="exchange\\[body\\]"', "the exchange body"),
    errors: parseJsonObject(textarea(html, 'id="exchange_errors"') ?? ""),
    has_data: data !== "" && data !== "{}",
    data_digest: createHash("sha256").update(data).digest("hex").slice(0, 16),
  };
}

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(headers).map((key) => [key, REDACTED]));
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

function optionalJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function optionalTags(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return Array.isArray(value) ? value.map(String).join(",") : String(value);
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
    tags: optionalTags(body.tags),
    static_body: optionalJson(body.static_body),
    fields: optionalJson(body.fields),
    data: optionalJson(body.data),
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
      const key = Object.keys(entries).find(
        (name) => basename(name) === suffix && !name.split("/").includes("__MACOSX"),
      );
      const bytes = key === undefined ? undefined : entries[key];
      return bytes === undefined ? undefined : decoder.decode(bytes);
    };
    const configuration = pick("configuration.yml");
    const template = pick("template.html.liquid");
    if (configuration === undefined || template === undefined) {
      throw new Error(`${basename(path)}: expected configuration.yml and template.html.liquid inside the zip.`);
    }
    return {
      configuration: parseConfiguration(configuration, `${basename(path)}/configuration.yml`),
      configurationText: configuration,
      template,
    };
  }

  const configurationPath = join(path, "configuration.yml");
  const templatePath = join(path, "template.html.liquid");
  const configurationText = readFileSync(configurationPath, "utf8");
  return {
    configuration: parseConfiguration(configurationText, configurationPath),
    configurationText,
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameHeaders(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return stableJson(a) === stableJson(b);
}

export function bodyText(body: unknown): string {
  if (body === null || body === undefined) return "";
  return typeof body === "object" ? JSON.stringify(body) : String(body);
}

export function exchangeFields(
  template: string,
  verb: string,
  headers: Record<string, unknown>,
  body: string,
): FormFields {
  return {
    "exchange[template]": template,
    "exchange[verb]": verb,
    "exchange[headers]": Object.keys(headers).length > 0 ? JSON.stringify(headers) : "",
    "exchange[body]": body,
  };
}

export function sameMatrix(a: BuildMatrix, b: BuildMatrix): boolean {
  const key = (ids: string[]): string => [...ids].sort().join(",");
  return key(a.device_ids) === key(b.device_ids) && key(a.model_ids) === key(b.model_ids);
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
    throw new TerminusError("GET", `/extensions/${extensionId}/export`, response.status, await response.text());
  }
  return new Uint8Array(await response.arrayBuffer());
}
