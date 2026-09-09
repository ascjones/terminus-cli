import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePassword } from "./client.ts";
import {
  CONFIG_FILENAME,
  EMPTY_CONFIG,
  findConfigFile,
  loadConfig,
  parseConfig,
  resolveSettings,
} from "./config.ts";

const temporaryDirectories: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "terminus-cli-test-"));
  temporaryDirectories.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseConfig", () => {
  it("reads every key, resolving screens against the config file not the working directory", () => {
    const config = parseConfig(
      '{"url":"http://localhost:2300","email":"a@example.com","screens":"screens"}',
      "/home/me/project/terminus-cli.json",
    );
    expect(config).toMatchObject({
      url: "http://localhost:2300",
      email: "a@example.com",
      screensDir: "/home/me/project/screens",
    });
  });

  it("leaves an absolute screens path alone, and leaves screens unset when absent", () => {
    expect(parseConfig('{"screens": "/srv/screens"}', "/home/me/terminus-cli.json").screensDir).toBe(
      "/srv/screens",
    );
    expect(parseConfig('{"url": "http://x:2300"}', "/home/me/terminus-cli.json").screensDir).toBeUndefined();
  });

  it("refuses a literal password, since the file gets committed", () => {
    expect(() => parseConfig('{"password":"hunter2"}', "/x/terminus-cli.json")).toThrow(
      /must not contain a password.*TERMINUS_PASSWORD/s,
    );
  });

  it("rejects a mistyped key and a non-string value, instead of silently ignoring either", () => {
    expect(() => parseConfig('{"screen":"screens"}', "/x/terminus-cli.json")).toThrow(/unknown key screen/);
    expect(() => parseConfig('{"url": 2300}', "/x/terminus-cli.json")).toThrow(/"url" must be a non-empty string/);
    expect(() => parseConfig('{"url": ""}', "/x/terminus-cli.json")).toThrow(/"url" must be a non-empty string/);
  });

  it("names the file when the JSON is broken", () => {
    expect(() => parseConfig("{oops}", "/x/terminus-cli.json")).toThrow(/^\/x\/terminus-cli\.json: not valid JSON/);
    expect(() => parseConfig("[]", "/x/terminus-cli.json")).toThrow(/expected a JSON object/);
  });
});

describe("findConfigFile", () => {
  it("walks up from a subdirectory to the project root", () => {
    const root = project({ [CONFIG_FILENAME]: "{}", "screens/week.liquid": "" });
    expect(findConfigFile(join(root, "screens"))).toBe(join(root, CONFIG_FILENAME));
  });

  it("stops at the nearest one", () => {
    const root = project({ [CONFIG_FILENAME]: "{}", [`inner/${CONFIG_FILENAME}`]: "{}" });
    expect(findConfigFile(join(root, "inner"))).toBe(join(root, "inner", CONFIG_FILENAME));
  });

  it("gives up at the filesystem root rather than looping", () => {
    const root = project({ "empty/.keep": "" });
    expect(findConfigFile(join(root, "empty"))).toBeNull();
  });
});

describe("loadConfig", () => {
  it("resolves a screens path against the file it walked up to, or reports no file at all", () => {
    const root = project({ [CONFIG_FILENAME]: '{"screens":"screens"}', "sub/deep/.keep": "" });
    expect(loadConfig(join(root, "sub", "deep")).screensDir).toBe(join(root, "screens"));
    expect(loadConfig(join(project({ "empty/.keep": "" }), "empty"))).toEqual(EMPTY_CONFIG);
  });
});

describe("resolveSettings", () => {
  const config = {
    file: "/proj/terminus-cli.json",
    url: "http://config:2300",
    email: "config@example.com",
    screensDir: "/proj/screens",
  };
  const noFlags = { url: undefined, email: undefined, screens: undefined };

  it("prefers a flag over the environment over the file", () => {
    const settings = resolveSettings(
      { url: "http://flag:2300", email: undefined, screens: undefined },
      { TERMINUS_URL: "http://env:2300", TERMINUS_EMAIL: "env@example.com" },
      config,
      "/cwd",
    );
    expect(settings.url).toBe("http://flag:2300");
    expect(settings.email).toBe("env@example.com");
  });

  it("falls back to the file for everything the flags and environment leave unset", () => {
    const settings = resolveSettings(noFlags, {}, config, "/cwd");
    expect(settings).toEqual({
      url: "http://config:2300",
      email: "config@example.com",
        screensDir: "/proj/screens",
      configFile: "/proj/terminus-cli.json",
      sources: {
        url: CONFIG_FILENAME,
        email: CONFIG_FILENAME,
        password: null,
        screens: CONFIG_FILENAME,
      },
    });
  });

  it("resolves a flag or environment screens path against the working directory", () => {
    expect(resolveSettings({ ...noFlags, screens: "screens" }, {}, config, "/cwd").screensDir).toBe("/cwd/screens");
    expect(resolveSettings(noFlags, { TERMINUS_SCREENS_DIR: "s" }, config, "/cwd").screensDir).toBe("/cwd/s");
    expect(resolveSettings({ ...noFlags, screens: "/abs" }, {}, config, "/cwd").screensDir).toBe("/abs");
  });

  it("is all undefined when there is nothing anywhere", () => {
    const settings = resolveSettings(noFlags, {}, EMPTY_CONFIG, "/cwd");
    expect(settings).toEqual({
      url: undefined,
      email: undefined,
      screensDir: undefined,
      configFile: null,
      sources: { url: null, email: null, password: null, screens: null },
    });
  });
});

describe("resolveSettings sources", () => {
  const config = {
    file: "/proj/terminus-cli.json",
    url: "http://config:2300",
    email: undefined,
    screensDir: "/proj/screens",
  };
  const noFlags = { url: undefined, email: undefined, screens: undefined };

  it("names the source of each setting", () => {
    const settings = resolveSettings(
      { url: "http://flag:2300", email: undefined, screens: "s" },
      { TERMINUS_EMAIL: "env@example.com" },
      config,
      "/cwd",
    );
    expect(settings.sources).toEqual({
      url: "--url",
      email: "TERMINUS_EMAIL",
      password: null,
      screens: "--screens",
    });

    const withPassword = { TERMINUS_PASSWORD: "literal" };
    expect(resolveSettings(noFlags, withPassword, config, "/cwd").sources.password).toBe("TERMINUS_PASSWORD");
    expect(resolvePassword(withPassword)).toBe("literal");
  });

  it("treats an empty environment variable as unset", () => {
    const env = { TERMINUS_URL: "", TERMINUS_EMAIL: "", TERMINUS_PASSWORD: "", TERMINUS_SCREENS_DIR: "" };
    const settings = resolveSettings(noFlags, env, config, "/cwd");
    expect(settings.url).toBe(config.url);
    expect(settings.screensDir).toBe(config.screensDir);
    expect(settings.sources.password).toBeNull();
  });

});
