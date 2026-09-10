import { writeFileSync } from "node:fs";
import { zipSync } from "fflate";
import { extractCsrfToken, type TerminusClient } from "../client.ts";
import { orDash, print, table } from "../format.ts";
import type { Envelope, Screen } from "../types.ts";
import {
  type BuildMatrix,
  type ExchangeState,
  type ExtensionCard,
  type ExtensionSource,
  exportExtension,
  extensionFields,
  listExtensions,
  readBuildMatrix,
  readExchanges,
  readExtensionSource,
  resolveSourcePath,
  redactHeaders,
  resolveExtension,
} from "../extensions.ts";

const REFRESH_POLL_MS = 500;
const REFRESH_TIMEOUT_MS = 15_000;
const BUILD_POLL_MS = 1000;
const BUILD_TIMEOUT_MS = 60_000;

export interface ExtensionFlags {
  out?: string | undefined;
  template?: string | undefined;
  headers?: string | undefined;
  verb?: string | undefined;
  exchange?: string | undefined;
  wait: boolean;
  build: boolean;
  screensDir?: string | undefined;
}

export async function extensionList(client: TerminusClient, asJson: boolean): Promise<void> {
  const cards = await listExtensions(client);
  print(cards, asJson, () =>
    table(
      ["ID", "NAME", "LABEL", "KIND"],
      cards.map((card) => [String(card.id), card.name, card.label, card.kind]),
      "No extensions.",
    ),
  );
}

interface ExtensionDetail extends ExtensionCard {
  build_matrix: BuildMatrix;
  exchanges: (Omit<ExchangeState, "headers"> & { headers: Record<string, unknown> })[];
}

export async function extensionShow(
  client: TerminusClient,
  reference: string,
  asJson: boolean,
): Promise<void> {
  const card = await resolveExtension(client, reference);
  const [matrix, exchanges] = await Promise.all([
    readBuildMatrix(client, card.id),
    readExchanges(client, card.id),
  ]);
  const detail: ExtensionDetail = {
    ...card,
    build_matrix: matrix,
    exchanges: exchanges.map((exchange) => ({ ...exchange, headers: redactHeaders(exchange.headers) })),
  };

  print(detail, asJson, () => {
    const header =
      `extension ${card.id}  ${card.name}  "${card.label}"  kind=${card.kind}\n` +
      `devices=${matrix.device_ids.join(",") || "-"}  models=${matrix.model_ids.join(",") || "-"}`;
    const rows = detail.exchanges.map((exchange) => [
      String(exchange.id),
      exchange.verb,
      exchange.template,
      Object.keys(exchange.headers).join(",") || "-",
      exchange.has_data ? "yes" : "no",
      Object.keys(exchange.errors).length > 0 ? "yes" : "no",
    ]);
    return `${header}\n${table(["EXCH", "VERB", "URL", "HEADERS", "DATA", "ERRORS"], rows, "  (no exchanges)")}`;
  });
}

export async function extensionExport(
  client: TerminusClient,
  reference: string,
  out: string | undefined,
  asJson: boolean,
): Promise<void> {
  const card = await resolveExtension(client, reference);
  const bytes = await exportExtension(client, card.id);
  const path = out ?? `extension-${card.name}.zip`;
  writeFileSync(path, bytes);
  print({ id: card.id, name: card.name, path, bytes: bytes.length }, asJson, () =>
    `wrote ${path} (${bytes.length} bytes)`,
  );
}

function exchangeErrorLines(exchange: ExchangeState): string {
  const entries = Object.entries(exchange.errors);
  if (entries.length === 0) return "errors: none";
  return entries
    .map(([source, detail]) => {
      const one = (detail ?? {}) as Record<string, unknown>;
      return `errors: ${source} code=${orDash(one.code as number | null)} ${String(one.body ?? "").slice(0, 200)}`;
    })
    .join("\n");
}

export async function extensionExchangeSet(
  client: TerminusClient,
  reference: string,
  flags: ExtensionFlags,
  asJson: boolean,
): Promise<void> {
  const card = await resolveExtension(client, reference);
  const exchanges = await readExchanges(client, card.id);
  if (exchanges.length === 0) throw new Error(`Extension ${card.name} has no exchanges.`);

  const current = flags.exchange
    ? exchanges.find((exchange) => exchange.id === Number(flags.exchange))
    : exchanges[0];
  if (!current) {
    throw new Error(`Extension ${card.name} has no exchange ${flags.exchange}.`);
  }
  if (!flags.exchange && exchanges.length > 1) {
    throw new Error(
      `Extension ${card.name} has ${exchanges.length} exchanges (${exchanges.map((e) => e.id).join(", ")}). Pass --exchange <id>.`,
    );
  }

  let headers = current.headers;
  if (flags.headers !== undefined) {
    try {
      headers = JSON.parse(flags.headers) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`--headers must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const path = `/extensions/${card.id}/exchanges/${current.id}`;
  await client.form(
    "PUT",
    path,
    {
      "exchange[template]": flags.template ?? current.template,
      "exchange[verb]": flags.verb ?? current.verb,
      "exchange[headers]": Object.keys(headers).length > 0 ? JSON.stringify(headers) : "",
      "exchange[body]": current.body,
    },
    { csrfFrom: `${path}/edit` },
  );

  const after = await awaitRefresh(client, card.id, current);
  const result = {
    extension: card.name,
    exchange: current.id,
    template: after?.template ?? "",
    verb: after?.verb ?? "",
    headers: redactHeaders(after?.headers ?? {}),
    has_data: after?.has_data ?? false,
    errors: after?.errors ?? {},
  };
  print(result, asJson, () =>
    `${card.name} exchange ${current.id} -> ${result.template} (${result.verb})\n` +
      `data: ${result.has_data ? "populated" : "empty"}\n${exchangeErrorLines(after ?? current)}`,
  );
}

function refreshFingerprint(exchange: ExchangeState): string {
  return `${exchange.template}|${exchange.verb}|${exchange.has_data}|${JSON.stringify(exchange.errors)}`;
}

async function awaitRefresh(
  client: TerminusClient,
  extensionId: number,
  before: ExchangeState,
): Promise<ExchangeState | undefined> {
  const was = refreshFingerprint(before);
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  let latest: ExchangeState | undefined;
  for (;;) {
    latest = (await readExchanges(client, extensionId)).find((exchange) => exchange.id === before.id);
    if (latest && refreshFingerprint(latest) !== was) return latest;
    if (Date.now() > deadline) return latest;
    await new Promise((resolve) => setTimeout(resolve, REFRESH_POLL_MS));
  }
}

async function screenFor(client: TerminusClient, name: string): Promise<Screen | undefined> {
  const response = await client.json<Envelope<Screen[]>>("GET", "/api/screens");
  return response.data.find((screen) => screen.name === `extension-${name}`);
}

export async function extensionBuild(
  client: TerminusClient,
  reference: string,
  flags: ExtensionFlags,
  asJson: boolean,
): Promise<void> {
  const card = await resolveExtension(client, reference);
  const matrix = await readBuildMatrix(client, card.id);
  if (matrix.device_ids.length === 0 && matrix.model_ids.length === 0) {
    throw new Error(
      `Extension ${card.name} has an empty build matrix, so a build would render nothing. Attach a device or model first.`,
    );
  }
  const before = await screenFor(client, card.name);
  await client.form("POST", `/extensions/${card.id}/build`, {}, { csrfFrom: `/extensions/${card.id}/edit` });

  let after = before;
  if (flags.wait) {
    const deadline = Date.now() + BUILD_TIMEOUT_MS;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, BUILD_POLL_MS));
      after = await screenFor(client, card.name);
      if (after && after.updated_at !== before?.updated_at) break;
      if (Date.now() > deadline) {
        throw new Error(`Build of ${card.name} did not produce a new screen within ${BUILD_TIMEOUT_MS / 1000}s.`);
      }
    }
  }

  const result = {
    extension: card.name,
    enqueued: true,
    waited: flags.wait,
    screen: after ? { id: after.id, name: after.name, size: after.size, updated_at: after.updated_at } : null,
  };
  print(result, asJson, () =>
    flags.wait && after
      ? `built ${card.name} -> screen ${after.id} ${after.name} ${orDash(after.size)} bytes at ${after.updated_at}`
      : `build of ${card.name} enqueued`,
  );
}

async function importExtension(client: TerminusClient, source: ExtensionSource): Promise<ExtensionCard> {
  const encoder = new TextEncoder();
  const zip = zipSync({
    "configuration.yml": encoder.encode(toConfigurationYaml(source)),
    "template.html.liquid": encoder.encode(source.template),
  });

  const csrf = extractCsrfToken(await client.html("/extensions"));
  const body = new FormData();
  body.set("_csrf_token", csrf);
  body.set(
    "extension[attachment]",
    new File([zip], `${source.configuration.name}.zip`, { type: "application/zip" }),
  );

  const response = await client.request("POST", "/extensions/import", {
    method: "POST",
    body,
    redirect: "manual",
  });
  if (response.status >= 400) {
    throw new Error(`POST /extensions/import -> HTTP ${response.status}\n${await response.text()}`);
  }
  const created = (await listExtensions(client)).find((card) => card.name === source.configuration.name);
  if (!created) throw new Error(`Import of ${source.configuration.name} reported success but no extension appeared.`);
  return created;
}

function toConfigurationYaml(source: ExtensionSource): string {
  const configuration = source.configuration;
  const scalar = (value: string | null): string => (value === null || value === "" ? "" : ` ${JSON.stringify(value)}`);
  const exchanges = configuration.exchanges
    .map((exchange) => {
      const headers = Object.entries(exchange.headers)
        .map(([key, value]) => `    ${key}: ${JSON.stringify(String(value))}`)
        .join("\n");
      return [
        `- headers:${headers ? `\n${headers}` : " {}"}`,
        `  verb: ${exchange.verb}`,
        `  body:`,
        `  template: ${JSON.stringify(exchange.template)}`,
      ].join("\n");
    })
    .join("\n");

  return [
    "---",
    "version: 0.72.0",
    `name: ${configuration.name}`,
    `label: ${JSON.stringify(configuration.label)}`,
    `description: ${JSON.stringify(configuration.description)}`,
    `mode:${scalar(configuration.mode)}`,
    `kind: ${configuration.kind}`,
    "tags: []",
    `static_body:${scalar(configuration.static_body)}`,
    `fields:${scalar(configuration.fields)}`,
    `data:${scalar(configuration.data)}`,
    `interval:${scalar(configuration.interval)}`,
    `unit:${scalar(configuration.unit)}`,
    "days: []",
    `last_day_of_month: ${configuration.last_day_of_month}`,
    `start_at: ${JSON.stringify(configuration.start_at)}`,
    exchanges ? `exchanges:\n${exchanges}` : "exchanges: []",
    "",
  ].join("\n");
}

export async function extensionPush(
  client: TerminusClient,
  path: string,
  flags: ExtensionFlags,
  asJson: boolean,
): Promise<void> {
  const source = readExtensionSource(resolveSourcePath(path, flags.screensDir));
  const name = source.configuration.name;
  const existing = (await listExtensions(client)).find((card) => card.name === name);

  if (!existing) {
    const created = await importExtension(client, source);
    print({ extension: name, id: created.id, created: true, built: false }, asJson, () =>
      `created ${name} as extension ${created.id}. Its build matrix is empty, so nothing was built — ` +
        `attach a device, then run: terminus extension build ${name}`,
    );
    return;
  }

  const matrix = await readBuildMatrix(client, existing.id);
  await client.form("PUT", `/extensions/${existing.id}`, extensionFields(source, matrix), {
    csrfFrom: `/extensions/${existing.id}/edit`,
  });

  const after = await readBuildMatrix(client, existing.id);
  if (after.device_ids.join(",") !== matrix.device_ids.join(",")) {
    throw new Error(
      `Build matrix changed during push of ${name}: was [${matrix.device_ids}], now [${after.device_ids}].`,
    );
  }

  const exchanges = await readExchanges(client, existing.id);
  const updated: number[] = [];
  for (const [index, wanted] of source.configuration.exchanges.entries()) {
    const current = exchanges[index];
    if (!current || !wanted.template) continue;
    if (current.template === wanted.template && current.verb === wanted.verb) continue;
    const exchangePath = `/extensions/${existing.id}/exchanges/${current.id}`;
    await client.form(
      "PUT",
      exchangePath,
      {
        "exchange[template]": wanted.template,
        "exchange[verb]": wanted.verb,
        "exchange[headers]":
          Object.keys(wanted.headers).length > 0 ? JSON.stringify(wanted.headers) : "",
        "exchange[body]": current.body,
      },
      { csrfFrom: `${exchangePath}/edit` },
    );
    updated.push(current.id);
  }

  let built = false;
  if (flags.build && (matrix.device_ids.length > 0 || matrix.model_ids.length > 0)) {
    await client.form("POST", `/extensions/${existing.id}/build`, {}, { csrfFrom: `/extensions/${existing.id}/edit` });
    built = true;
  }

  print(
    { extension: name, id: existing.id, created: false, build_matrix: after, exchanges_updated: updated, built },
    asJson,
    () =>
      `updated ${name} (extension ${existing.id}), devices=${after.device_ids.join(",") || "-"}` +
      `\nexchanges updated: ${updated.join(", ") || "none"}` +
      `\n${built ? "build enqueued" : "build skipped"}`,
  );
}
