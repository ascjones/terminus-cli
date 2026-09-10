import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extensionFields,
  parseBuildMatrix,
  parseConfiguration,
  parseExchangeForm,
  parseExchangeIds,
  parseExtensionIndex,
  readExtensionSource,
  redactHeaders,
} from "./extensions.ts";

const INDEX = `
<ul>
<li id="1" class="bit-card extension">
  <h2 class="label">Family Week</h2>
  <span>poll</span>
  <a href="/extensions/1/edit"></a>
  <a download="extension-family_week.zip" href="/extensions/1/export"></a>
</li>
<li id="2" class="bit-card extension">
  <h2 class="label">Family Day</h2>
  <span>poll</span>
  <a download="extension-family_day.zip" href="/extensions/2/export"></a>
</li>
</ul>`;

const EDIT = `
<select name="extension[device_ids][]" multiple>
  <option value="1">Other</option>
  <option value="2" selected="selected">TRMNL</option>
</select>
<select name="extension[model_ids][]" multiple>
  <option value="1">trmnl</option>
</select>`;

const EXCHANGE_EDIT = `
<form action="/extensions/1/exchanges/1" method="POST">
<textarea name="exchange[headers]">
{"Authorization": "Bearer secret-value"}</textarea>
<input type="radio" name="exchange[verb]" value="get" checked="checked">
<input type="radio" name="exchange[verb]" value="post">
<textarea name="exchange[template]">
http://rota:3300/api/week</textarea>
<textarea name="exchange[body]">
</textarea>
<textarea name="exchange[data]" id="exchange_data">
{ &quot;source_1&quot;: { &quot;days&quot;: [] } }</textarea>
<textarea name="exchange[data]" id="exchange_errors">
{
  &quot;source_1&quot;: { &quot;uri&quot;: &quot;http://rota:3300/api/week&quot;, &quot;code&quot;: 401 }
}</textarea>
</form>`;

const CONFIGURATION = `---
version: 0.72.0
name: family_week
label: Family Week
description: A row per child, seven equal columns, today by tone. Data from the rota
  service.
mode: dither
kind: poll
tags: []
static_body:
fields:
data:
interval: 15
unit: minute
days: []
last_day_of_month: false
start_at: '2026-08-31T23:00:00+00:00'
exchanges:
- headers:
    Authorization: Bearer secret-value
  verb: get
  body:
  template: http://rota:3300/api/week
`;

describe("parseExtensionIndex", () => {
  it("reads id, name, label and kind, taking the name from the download filename", () => {
    expect(parseExtensionIndex(INDEX)).toEqual([
      { id: 1, name: "family_week", label: "Family Week", kind: "poll" },
      { id: 2, name: "family_day", label: "Family Day", kind: "poll" },
    ]);
    expect(parseExtensionIndex("<ul></ul>")).toEqual([]);
  });

  it("throws when the cards are there but no longer parse, rather than reporting none", () => {
    expect(() => parseExtensionIndex('<li class="bit-card extension">changed</li>')).toThrow(/markup/);
  });
});

describe("parseBuildMatrix", () => {
  it("reads only the selected options, per select", () => {
    expect(parseBuildMatrix(EDIT)).toEqual({ device_ids: ["2"], model_ids: [] });
    expect(parseBuildMatrix("")).toEqual({ device_ids: [], model_ids: [] });
  });
});

describe("parseExchangeIds", () => {
  it("takes the ids for one extension, without duplicates", () => {
    const html = '<a href="/extensions/1/exchanges/1/edit"></a><a href="/extensions/1/exchanges/1/edit"></a>' +
      '<a href="/extensions/2/exchanges/9/edit"></a>';
    expect(parseExchangeIds(html, 1)).toEqual([1]);
    expect(parseExchangeIds(html, 2)).toEqual([9]);
  });
});

describe("parseExchangeForm", () => {
  it("reads the URL, verb, headers and errors, and tells data apart from errors", () => {
    const exchange = parseExchangeForm(EXCHANGE_EDIT, 1);
    expect(exchange.template).toBe("http://rota:3300/api/week");
    expect(exchange.verb).toBe("get");
    expect(exchange.headers).toEqual({ Authorization: "Bearer secret-value" });
    expect(exchange.has_data).toBe(true);
    // Both read-only textareas are named exchange[data]; only the second holds errors.
    expect(exchange.errors).toEqual({ source_1: { uri: "http://rota:3300/api/week", code: 401 } });
  });
});

describe("redactHeaders", () => {
  it("hides credential headers and keeps the rest", () => {
    expect(redactHeaders({ Authorization: "Bearer x", "X-Api-Key": "k", Accept: "application/json" })).toEqual({
      Authorization: "[redacted]",
      "X-Api-Key": "[redacted]",
      Accept: "application/json",
    });
  });
});

describe("parseConfiguration", () => {
  it("reads a real export, including a folded description and the exchange", () => {
    const configuration = parseConfiguration(CONFIGURATION, "configuration.yml");
    expect(configuration.name).toBe("family_week");
    expect(configuration.description).toContain("Data from the rota service.");
    expect(configuration.interval).toBe("15");
    expect(configuration.last_day_of_month).toBe(false);
    expect(configuration.exchanges).toEqual([
      { template: "http://rota:3300/api/week", verb: "get", headers: { Authorization: "Bearer secret-value" }, body: null },
    ]);
  });

  it("names the file when a required field is missing or the YAML is not a mapping", () => {
    expect(() => parseConfiguration("label: x\nkind: poll\n", "c.yml")).toThrow(/c\.yml: "name" is required/);
    expect(() => parseConfiguration("- a\n- b\n", "c.yml")).toThrow(/c\.yml: expected a YAML mapping/);
  });
});

describe("readExtensionSource", () => {
  it("reads the same extension from a directory and from a zip", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-cli-src-"));
    writeFileSync(join(root, "configuration.yml"), CONFIGURATION);
    writeFileSync(join(root, "template.html.liquid"), "<div>hi</div>");
    const encoder = new TextEncoder();
    const zipPath = join(root, "packed.zip");
    writeFileSync(
      zipPath,
      zipSync({
        "configuration.yml": encoder.encode(CONFIGURATION),
        "template.html.liquid": encoder.encode("<div>hi</div>"),
      }),
    );

    const fromDirectory = readExtensionSource(root);
    const fromZip = readExtensionSource(zipPath);
    expect(fromZip.configuration).toEqual(fromDirectory.configuration);
    expect(fromZip.template).toBe("<div>hi</div>");
  });

  it("says what a zip is missing rather than failing obscurely", () => {
    const root = mkdtempSync(join(tmpdir(), "terminus-cli-src-"));
    const zipPath = join(root, "bad.zip");
    writeFileSync(zipPath, zipSync({ "readme.txt": new TextEncoder().encode("nope") }));
    expect(() => readExtensionSource(zipPath)).toThrow(/expected configuration\.yml and template\.html\.liquid/);
  });
});

describe("extensionFields", () => {
  const source = { configuration: parseConfiguration(CONFIGURATION, "c.yml"), template: "<div>hi</div>" };

  it("always sends device_ids, because omitting it clears the build matrix", () => {
    const fields = extensionFields(source, { device_ids: ["2"], model_ids: [] });
    expect(fields["extension[device_ids][]"]).toEqual(["2"]);
    expect(fields["extension[model_ids][]"]).toEqual([]);
    expect(Object.keys(fields)).toContain("extension[device_ids][]");
  });

  it("sends the whole settings field set, since the update is not a partial one", () => {
    const fields = extensionFields(source, { device_ids: [], model_ids: [] });
    for (const field of ["name", "label", "description", "kind", "tags", "static_body", "fields", "data",
      "interval", "last_day_of_month", "start_at", "template"]) {
      expect(Object.keys(fields)).toContain(`extension[${field}]`);
    }
    expect(fields["extension[template]"]).toBe("<div>hi</div>");
  });
});
