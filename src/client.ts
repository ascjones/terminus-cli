import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LoginResponse } from "./types.ts";

export const USER_AGENT = "terminus-cli/0.0.0";

export function defaultTokenCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "terminus-cli", "token.json");
}

const OP_READ_TIMEOUT_MS = 10_000;

const EXPIRY_MARGIN_SECONDS = 60;

export class TerminusError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} -> HTTP ${status}`);
    this.name = "TerminusError";
    this.status = status;
    this.method = method;
    this.path = path;
    this.body = body;
  }

  get report(): string {
    return this.body.trim() ? `${this.message}\n${this.body.trim()}` : this.message;
  }
}

export class CookieJar {
  #cookies = new Map<string, string>();

  store(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get size(): number {
    return this.#cookies.size;
  }
}

export function extractCsrfToken(html: string): string {
  const match = /name="_csrf_token"[^>]*?\bvalue="([^"]+)"/.exec(html);
  if (!match?.[1]) {
    throw new Error(
      "No _csrf_token found in the page. The markup this CLI scrapes may have changed; " +
        "see docs/research/terminus-cli.md.",
    );
  }
  return match[1];
}

export function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims === "object" && claims !== null && "exp" in claims) {
      const exp = (claims as { exp: unknown }).exp;
      if (typeof exp === "number") return exp;
    }
    return null;
  } catch {
    return null;
  }
}

export function tokenIsUsable(token: string, nowSeconds = Date.now() / 1000): boolean {
  const exp = jwtExpiry(token);
  if (exp === null) return false;
  return exp - EXPIRY_MARGIN_SECONDS > nowSeconds;
}

export function resolvePassword(env: NodeJS.ProcessEnv = process.env, configRef?: string): string {
  const direct = env.TERMINUS_PASSWORD;
  if (direct) return direct;

  const ref = env.TERMINUS_PASSWORD_REF || configRef;
  if (!ref) {
    throw new Error(
      "No password source. Set TERMINUS_PASSWORD_REF (an op:// reference), or password_ref in " +
        "terminus-cli.json, or TERMINUS_PASSWORD.",
    );
  }

  const result = spawnSync("op", ["read", ref], { encoding: "utf8", timeout: OP_READ_TIMEOUT_MS });
  if (result.error) {
    throw new Error(`Could not run \`op read\` to resolve TERMINUS_PASSWORD_REF: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`\`op read ${ref}\` failed:\n${(result.stderr || "").trim()}`);
  }
  const password = result.stdout.replace(/\n$/, "");
  if (!password) throw new Error(`\`op read ${ref}\` returned nothing.`);
  return password;
}

export function problemStatus(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if ("data" in body) return null;
  return typeof body.status === "number" && body.status >= 400 ? body.status : null;
}

export function connectionDetail(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const inner = cause.cause;
  if (inner instanceof AggregateError && inner.errors.length > 0) return String(inner.errors[0]);
  if (inner instanceof Error) return inner.message;
  return cause.message;
}

export interface ClientOptions {
  url: string;
  email: string;
  password: () => string;
  tokenCachePath?: string | null;
  fetch?: typeof globalThis.fetch;
  verbose?: boolean;
}

interface CachedToken {
  url: string;
  email: string;
  access_token: string;
}

export type FormFields = Record<string, string | string[]>;

export class TerminusClient {
  readonly url: string;
  readonly email: string;
  readonly jar = new CookieJar();

  #password: () => string;
  #tokenCachePath: string | null;
  #fetch: typeof globalThis.fetch;
  #verbose: boolean;
  #token: string | null = null;
  #tokenIsFresh = false;

  constructor(options: ClientOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.email = options.email;
    this.#password = options.password;
    this.#tokenCachePath =
      options.tokenCachePath === undefined ? defaultTokenCachePath() : options.tokenCachePath;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#verbose = options.verbose ?? false;
  }

  async accessToken(): Promise<string> {
    if (this.#token && tokenIsUsable(this.#token)) return this.#token;

    const cached = this.#readCachedToken();
    if (cached && tokenIsUsable(cached)) {
      this.#token = cached;
      this.#tokenIsFresh = false;
      return cached;
    }

    return this.#refreshToken();
  }

  async #refreshToken(): Promise<string> {
    const token = await this.#login();
    this.#token = token;
    this.#tokenIsFresh = true;
    this.#writeCachedToken(token);
    return token;
  }

  #evictToken(): void {
    this.#token = null;
    const file = this.#cacheFile();
    if (!file) return;
    try {
      unlinkSync(file);
    } catch {
    }
  }

  async #send(method: string, url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (cause) {
      throw new Error(`${method} ${url} could not connect: ${connectionDetail(cause)}`);
    }
  }

  async #login(): Promise<string> {
    const path = "/login";
    const response = await this.#send("POST", `${this.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({ login: this.email, password: this.#password() }),
      redirect: "manual",
    });
    this.jar.store(response.headers);
    const text = await response.text();
    this.#log("POST", path, response.status);
    if (!response.ok) throw new TerminusError("POST", path, response.status, text);

    const parsed = JSON.parse(text) as Partial<LoginResponse>;
    if (!parsed.access_token) {
      throw new TerminusError("POST", path, response.status, "No access_token in the login response.");
    }
    return parsed.access_token;
  }

  #cacheFile(): string | null {
    return this.#tokenCachePath === null ? null : resolve(this.#tokenCachePath);
  }

  #readCachedToken(): string | null {
    const file = this.#cacheFile();
    if (!file) return null;
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as Partial<CachedToken>;
      if (cached.url !== this.url || cached.email !== this.email) return null;
      return typeof cached.access_token === "string" && cached.access_token ? cached.access_token : null;
    } catch {
      return null;
    }
  }

  #writeCachedToken(token: string): void {
    const file = this.#cacheFile();
    if (!file) return;
    const entry: CachedToken = { url: this.url, email: this.email, access_token: token };
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
    }
  }

  #log(method: string, path: string, status: number): void {
    if (this.#verbose) process.stderr.write(`${method} ${path} -> ${status}\n`);
  }

  async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#authenticated(method, path, init, await this.accessToken());
    if (response.status !== 401 || this.#tokenIsFresh) return response;

    this.#evictToken();
    return this.#authenticated(method, path, init, await this.#refreshToken());
  }

  async #authenticated(method: string, path: string, init: RequestInit, token: string): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", USER_AGENT);
    const cookie = this.jar.header();
    if (cookie) headers.set("Cookie", cookie);

    const response = await this.#send(method, `${this.url}${path}`, { ...init, headers });
    this.jar.store(response.headers);
    this.#log(method, path, response.status);
    return response;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, redirect: "manual" };
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    init.headers = headers;

    const response = await this.request(method, path, init);
    const text = await response.text();
    if (!response.ok) throw new TerminusError(method, path, response.status, text);

    const parsed: unknown = JSON.parse(text);
    const problem = problemStatus(parsed);
    if (problem !== null) throw new TerminusError(method, path, problem, text);
    return parsed as T;
  }

  async html(path: string): Promise<string> {
    const response = await this.request("GET", path, { method: "GET", redirect: "manual" });
    const text = await response.text();
    if (!response.ok) throw new TerminusError("GET", path, response.status, text);
    return text;
  }

  async form(
    method: "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    fields: FormFields = {},
    options: { csrfFrom?: string } = {},
  ): Promise<{ status: number; body: string; location: string | null }> {
    const csrfToken = extractCsrfToken(await this.html(options.csrfFrom ?? path));

    const params = new URLSearchParams();
    params.set("_csrf_token", csrfToken);
    for (const [name, value] of Object.entries(fields)) {
      for (const one of Array.isArray(value) ? value : [value]) params.append(name, one);
    }

    const response = await this.request(method, path, {
      method,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      redirect: "manual",
    });
    const body = await response.text();
    if (response.status >= 400) throw new TerminusError(method, path, response.status, body);
    return { status: response.status, body, location: response.headers.get("location") };
  }
}
