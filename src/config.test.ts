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

/** A throwaway project tree; `files` maps a relative path to its contents. */
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
  it("resolves a screens path against the config file, not the working directory", () => {
    const config = parseConfig('{"screens": "screens"}', "/home/me/project/terminus-cli.json");
    expect(config.screensDir).toBe("/home/me/project/screens");
  });

  it("leaves an absolute screens path alone", () => {
    const config = parseConfig('{"screens": "/srv/screens"}', "/home/me/terminus-cli.json");
    expect(config.screensDir).toBe("/srv/screens");
  });

  it("reads the remaining keys", () => {
    const config = parseConfig(
      '{"url":"http://localhost:2300","email":"a@example.com","password_ref":"op://V/i/password"}',
      "/x/terminus-cli.json",
    );
    expect(config).toMatchObject({
      url: "http://localhost:2300",
      email: "a@example.com",
      passwordRef: "op://V/i/password",
      screensDir: undefined,
    });
  });

  it("refuses a literal password, since the file gets committed", () => {
    expect(() => parseConfig('{"password":"hunter2"}', "/x/terminus-cli.json")).toThrow(
      /must not contain a password.*password_ref/s,
    );
  });

  it("rejects a mistyped key instead of silently ignoring it", () => {
    // A silently ignored "screen" would leave the CLI on a default the author thought they replaced.
    expect(() => parseConfig('{"screen":"screens"}', "/x/terminus-cli.json")).toThrow(/unknown key screen/);
  });

  it("rejects values that are not non-empty strings", () => {
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
    // A temp dir with no config anywhere beneath it; the walk terminates at /.
    const root = project({ "empty/.keep": "" });
    expect(findConfigFile(join(root, "empty"))).toBeNull();
  });
});

describe("loadConfig", () => {
  it("returns the empty config when there is no file", () => {
    expect(loadConfig(join(project({ "empty/.keep": "" }), "empty"))).toEqual(EMPTY_CONFIG);
  });

  it("resolves a screens path relative to the file it found while walking up", () => {
    const root = project({ [CONFIG_FILENAME]: '{"screens":"screens"}', "sub/deep/.keep": "" });
    expect(loadConfig(join(root, "sub", "deep")).screensDir).toBe(join(root, "screens"));
  });
});

describe("resolveSettings", () => {
  const config = {
    file: "/proj/terminus-cli.json",
    url: "http://config:2300",
    email: "config@example.com",
    passwordRef: "op://V/config/password",
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
    expect(settings.passwordRef).toBe("op://V/config/password");
  });

  it("falls back to the file for everything the flags and environment leave unset", () => {
    const settings = resolveSettings(noFlags, {}, config, "/cwd");
    expect(settings).toEqual({
      url: "http://config:2300",
      email: "config@example.com",
      passwordRef: "op://V/config/password",
      screensDir: "/proj/screens",
      configFile: "/proj/terminus-cli.json",
      sources: {
        url: CONFIG_FILENAME,
        email: CONFIG_FILENAME,
        password: CONFIG_FILENAME,
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
      passwordRef: undefined,
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
    passwordRef: "op://Vault/item/password",
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
      password: CONFIG_FILENAME,
      screens: "--screens",
    });
  });

  it("agrees with resolvePassword that a literal beats a reference", () => {
    // These two apply the same precedence rule in different places; this pins them together.
    const env = { TERMINUS_PASSWORD: "literal", TERMINUS_PASSWORD_REF: "op://Vault/item/password" };
    const settings = resolveSettings(noFlags, env, config, "/cwd");
    expect(settings.sources.password).toBe("TERMINUS_PASSWORD");
    expect(settings.passwordRef).toBeUndefined();
    expect(resolvePassword(env, config.passwordRef)).toBe("literal");
  });
});
