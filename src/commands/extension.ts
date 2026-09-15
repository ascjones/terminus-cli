import { readFileSync, writeFileSync } from "node:fs";
import { zipSync } from "fflate";
import { extractCsrfToken, TerminusError, type TerminusClient } from "../client.ts";
import { orDash, print, table } from "../format.ts";
import type { Envelope, Screen } from "../types.ts";
import {
  type BuildMatrix,
  type ExchangeState,
  type ExtensionCard,
  type ExtensionSource,
  bodyText,
  exchangeFields,
  exportExtension,
  extensionFields,
  listExtensions,
  readBuildMatrix,
  readExchanges,
  readExtensionSource,
  resolveSourcePath,
  redactHeaders,
  resolveExtension,
  sameHeaders,
  sameMatrix,
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

  const headers = flags.headers === undefined ? current.headers : parseHeadersFlag(flags.headers);
  if (flags.verb !== undefined && flags.verb !== "get" && flags.verb !== "post") {
    throw new Error(`--verb must be get or post, not "${flags.verb}".`);
  }
  const sent = { template: flags.template ?? current.template, verb: flags.verb ?? current.verb };

  const path = `/extensions/${card.id}/exchanges/${current.id}`;
  await client.form("PUT", path, exchangeFields(sent.template, sent.verb, headers, current.body), {
    csrfFrom: `${path}/edit`,
  });

  const { exchange: after, refreshed } = await awaitRefresh(client, card.id, current, sent);
  const result = {
    extension: card.name,
    exchange: current.id,
    template: after?.template ?? "",
    verb: after?.verb ?? "",
    headers: redactHeaders(after?.headers ?? {}),
    refreshed,
    has_data: after?.has_data ?? false,
    errors: after?.errors ?? {},
  };
  print(result, asJson, () =>
    `${card.name} exchange ${current.id} -> ${result.template} (${result.verb})\n` +
      (refreshed
        ? ""
        : `refresh: not observed within ${REFRESH_TIMEOUT_MS / 1000}s, so the data and errors below may predate this save\n`) +
      `data: ${result.has_data ? "populated" : "empty"}\n${exchangeErrorLines(after ?? current)}`,
  );
}

export function parseHeadersFlag(value: string): Record<string, unknown> {
  const text = value === "-" ? readFileSync(0, "utf8") : value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`--headers must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--headers must be a JSON object, such as {\"Authorization\": \"Bearer ...\"}.");
  }
  return parsed as Record<string, unknown>;
}

function refreshProducts(exchange: ExchangeState): string {
  return `${exchange.data_digest}|${JSON.stringify(exchange.errors)}`;
}

async function awaitRefresh(
  client: TerminusClient,
  extensionId: number,
  before: ExchangeState,
  sent: { template: string; verb: string },
): Promise<{ exchange: ExchangeState | undefined; refreshed: boolean }> {
  const was = refreshProducts(before);
  const deadline = Date.now() + REFRESH_TIMEOUT_MS;
  let latest: ExchangeState | undefined;
  for (;;) {
    latest = (await readExchanges(client, extensionId)).find((exchange) => exchange.id === before.id);
    const saved = latest !== undefined && latest.template === sent.template && latest.verb === sent.verb;
    if (saved && refreshProducts(latest as ExchangeState) !== was) return { exchange: latest, refreshed: true };
    if (Date.now() > deadline) return { exchange: latest, refreshed: false };
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
      `Extension ${card.name} has an empty build matrix, so a build would render nothing. ` +
        "Attach a device or model in the Terminus web UI; no CLI command sets the build matrix.",
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
        throw new Error(`Screen for ${card.name} did not change within ${BUILD_TIMEOUT_MS / 1000}s of enqueuing the build.`);
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
      ? `screen ${after.id} ${after.name} changed at ${after.updated_at} (${orDash(after.size)} bytes). ` +
        "A scheduled rebuild can also change it, so this does not prove the enqueued build finished."
      : `build of ${card.name} enqueued`,
  );
}

async function importExtension(client: TerminusClient, source: ExtensionSource): Promise<ExtensionCard> {
  const encoder = new TextEncoder();
  const zip = zipSync({
    "configuration.yml": encoder.encode(source.configurationText),
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
    throw new TerminusError("POST", "/extensions/import", response.status, await response.text());
  }
  const created = (await listExtensions(client)).find((card) => card.name === source.configuration.name);
  if (!created) throw new Error(`Import of ${source.configuration.name} reported success but no extension appeared.`);
  return created;
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
      `created ${name} as extension ${created.id}. Its build matrix is empty, so nothing was built. ` +
        `Attach a device in the Terminus web UI, then run: terminus extension build ${name}`,
    );
    return;
  }

  const matrix = await readBuildMatrix(client, existing.id);
  const exchanges = await readExchanges(client, existing.id);
  if (exchanges.length !== source.configuration.exchanges.length) {
    throw new Error(
      `Push of ${name} aborted before writing: configuration.yml has ${source.configuration.exchanges.length} ` +
        `exchange(s) but the server has ${exchanges.length}.`,
    );
  }

  await client.form("PUT", `/extensions/${existing.id}`, extensionFields(source, matrix), {
    csrfFrom: `/extensions/${existing.id}/edit`,
  });

  const after = await readBuildMatrix(client, existing.id);
  if (!sameMatrix(after, matrix)) {
    throw new Error(
      `Build matrix changed during push of ${name}: was devices [${matrix.device_ids}] models [${matrix.model_ids}], ` +
        `now devices [${after.device_ids}] models [${after.model_ids}].`,
    );
  }

  const updated: number[] = [];
  for (const [index, wanted] of source.configuration.exchanges.entries()) {
    const current = exchanges[index];
    if (!current || !wanted.template) continue;
    const body = wanted.body === null || wanted.body === undefined ? current.body : bodyText(wanted.body);
    if (
      current.template === wanted.template &&
      current.verb === wanted.verb &&
      sameHeaders(current.headers, wanted.headers) &&
      current.body === body
    ) {
      continue;
    }
    const exchangePath = `/extensions/${existing.id}/exchanges/${current.id}`;
    await client.form("PUT", exchangePath, exchangeFields(wanted.template, wanted.verb, wanted.headers, body), {
      csrfFrom: `${exchangePath}/edit`,
    });
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
