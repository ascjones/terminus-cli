import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminusClient } from "../client.ts";
import { extensionPush } from "./extension.ts";

const CSRF = `<input type="hidden" name="_csrf_token" value="${"c".repeat(64)}">`;

interface ServerState {
  devices: string[];
  models: string[];
  exchangeLinks: boolean;
  matrixMarkup: boolean;
  headers: string;
  onExtensionPut?: (state: ServerState) => void;
  writes: { method: string; path: string; body: URLSearchParams }[];
}

function options(ids: string[], all: string[]): string {
  return all.map((id) => `<option value="${id}"${ids.includes(id) ? ' selected="selected"' : ""}>${id}</option>`).join("");
}

function fakeServer(state: ServerState): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const route = `${method} ${url.pathname}`;
    const html = (body: string): Response => new Response(body, { status: 200 });

    if (route === "POST /login") {
      const exp = Math.floor(Date.now() / 1000) + 1800;
      const token = `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
      return new Response(JSON.stringify({ access_token: token }), { status: 200 });
    }
    if (route === "GET /extensions") {
      return html(
        `${CSRF}<li id="1" class="bit-card extension"><h2 class="label">Weather</h2><span>poll</span>` +
          `<a download="extension-weather.zip" href="/extensions/1/export"></a></li>`,
      );
    }
    if (route === "GET /extensions/1/edit") {
      const selects = state.matrixMarkup
        ? `<select name="extension[model_ids][]" multiple>${options(state.models, ["5", "6"])}</select>` +
          `<select name="extension[device_ids][]" multiple>${options(state.devices, ["2", "3"])}</select>`
        : "";
      return html(`${CSRF}${selects}`);
    }
    if (route === "GET /extensions/1/exchanges") {
      return html(state.exchangeLinks ? '<a href="/extensions/1/exchanges/1/edit"></a>' : "");
    }
    if (route === "GET /extensions/1/exchanges/1/edit") {
      return html(
        `${CSRF}<textarea name="exchange[headers]">\n${state.headers}</textarea>` +
          `<div x-data="{verb: 'get'}"></div>` +
          `<textarea name="exchange[template]">\nhttp://rota:3300/api/week</textarea>` +
          `<textarea name="exchange[body]">\n</textarea>` +
          `<textarea name="exchange[data]" id="exchange_data">\n{}</textarea>` +
          `<textarea name="exchange[data]" id="exchange_errors">\n{}</textarea>`,
      );
    }
    if (method === "PUT" || method === "POST") {
      state.writes.push({ method, path: url.pathname, body: new URLSearchParams(String(init?.body ?? "")) });
      if (route === "PUT /extensions/1") state.onExtensionPut?.(state);
      return new Response("", { status: route === "POST /extensions/1/build" ? 202 : 302 });
    }
    throw new Error(`Unexpected request: ${route}`);
  }) as unknown as typeof globalThis.fetch;
}

function source(headers: string): string {
  const root = mkdtempSync(join(tmpdir(), "terminus-cli-push-"));
  writeFileSync(
    join(root, "configuration.yml"),
    [
      "name: weather",
      "label: Weather",
      "kind: poll",
      "start_at: '2026-08-31T23:00:00+00:00'",
      "exchanges:",
      `- headers: ${headers}`,
      "  verb: get",
      "  body:",
      "  template: http://rota:3300/api/week",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "template.html.liquid"), "<div>hi</div>");
  return root;
}

function state(overrides: Partial<ServerState> = {}): ServerState {
  return {
    devices: ["2"],
    models: ["5"],
    exchangeLinks: true,
    matrixMarkup: true,
    headers: '{"Authorization": "Bearer old"}',
    writes: [],
    ...overrides,
  };
}

function push(server: ServerState, headers = '{"Authorization": "Bearer old"}'): Promise<void> {
  const client = new TerminusClient({
    url: "http://localhost:2300",
    email: "a@example.com",
    password: () => "secret",
    tokenCachePath: null,
    fetch: fakeServer(server),
  });
  return extensionPush(client, source(headers), { wait: false, build: false }, true);
}

beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extensionPush", () => {
  it("fails loudly when the read-back build matrix differs, including model ids alone", async () => {
    const server = state({ onExtensionPut: (current) => (current.models = []) });
    await expect(push(server)).rejects.toThrow(/Build matrix changed during push of weather/);
  });

  it("writes nothing when the build matrix cannot be read", async () => {
    const server = state({ matrixMarkup: false });
    await expect(push(server)).rejects.toThrow(/nothing was written/);
    expect(server.writes).toEqual([]);
  });

  it("writes nothing when the server's exchanges do not match the source", async () => {
    const server = state({ exchangeLinks: false });
    await expect(push(server)).rejects.toThrow(/aborted before writing/);
    expect(server.writes).toEqual([]);
  });

  it("resends the build matrix and pushes an exchange whose only change is its headers", async () => {
    const server = state();
    await push(server, '{"Authorization": "Bearer rotated"}');

    const extensionPut = server.writes.find((write) => write.path === "/extensions/1");
    expect(extensionPut?.body.getAll("extension[device_ids][]")).toEqual(["2"]);
    expect(extensionPut?.body.getAll("extension[model_ids][]")).toEqual(["5"]);

    const exchangePut = server.writes.find((write) => write.path === "/extensions/1/exchanges/1");
    expect(JSON.parse(exchangePut?.body.get("exchange[headers]") ?? "{}")).toEqual({ Authorization: "Bearer rotated" });
  });
});
