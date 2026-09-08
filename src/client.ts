/**
 * HTTP client for a self-hosted Terminus server.
 *
 * Terminus speaks two transports on the same origin, and this client covers both:
 *
 *   - the JSON API under `/api/...`, which is versioned and CSRF-exempt (`json`), and
 *   - session-authenticated HTML form posts, which is the only way to reach Extensions
 *     (`html` + `form`).
 *
 * Both are authenticated by the same JWT: `Terminus::Action#authorize` calls
 * `rodauth.require_account` for every action, and Rodauth treats a request as a JWT request
 * whenever an `Authorization` header is present. The extra ingredient for the HTML side is
 * Hanami's CSRF token, which has to be scraped from the page being posted to and sent back
 * with the session cookie handed out by that same GET — hence the cookie jar.
 *
 * See `docs/research/terminus-cli.md` for how all of that was established.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { LoginResponse } from "./types.ts";

export const USER_AGENT = "terminus-cli/0.0.0";

/** Where the access token is cached. Under `build/`, which is git-ignored. */
export const DEFAULT_TOKEN_CACHE = "build/.terminus-token.json";

/** Re-login this many seconds before the token actually expires. */
const EXPIRY_MARGIN_SECONDS = 60;

/**
 * A non-2xx response from Terminus, carrying the body verbatim.
 *
 * Verbatim matters: a 422 from a form post names the offending fields, and that is the whole
 * upgrade-survival story for the Extensions routes, where the field set mirrors a server-side
 * schema this CLI cannot see.
 */
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

  /** The message plus the response body, for printing to stderr. */
  get report(): string {
    return this.body.trim() ? `${this.message}\n${this.body.trim()}` : this.message;
  }
}

/**
 * A cookie jar for the lifetime of one process.
 *
 * Deliberately minimal: Terminus hands out exactly one cookie (`terminus.session`) on the same
 * origin every request goes to, so domain, path and expiry have nothing to decide.
 */
export class CookieJar {
  #cookies = new Map<string, string>();

  /** Absorb any `Set-Cookie` headers from a response. */
  store(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /** The `Cookie` request header, or undefined when the jar is empty. */
  header(): string | undefined {
    if (this.#cookies.size === 0) return undefined;
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  get size(): number {
    return this.#cookies.size;
  }
}

/**
 * Lift Hanami's CSRF token out of a rendered page.
 *
 * Mirrors the hidden input that `Hanami::Helpers::FormHelper` emits into every form:
 *   <input type="hidden" name="_csrf_token" value="<64 hex chars>">
 *
 * This is one of only a handful of places the CLI parses markup, and the most likely thing to
 * break across a Terminus upgrade. It fails loudly rather than posting a request that would be
 * rejected with a bare 500 (`InvalidCSRFTokenError`).
 */
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

/** The `exp` claim of a JWT, in seconds, or null when it cannot be read. */
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

/** True while the token has more than the safety margin left to run. */
export function tokenIsUsable(token: string, nowSeconds = Date.now() / 1000): boolean {
  const exp = jwtExpiry(token);
  if (exp === null) return false;
  return exp - EXPIRY_MARGIN_SECONDS > nowSeconds;
}

/**
 * Resolve the password without ever putting it in the environment or on a command line.
 *
 * `TERMINUS_PASSWORD_REF` is the preferred form: an `op://` reference resolved by the 1Password
 * CLI at the moment it is needed. `TERMINUS_PASSWORD` is the fallback for CI or a machine with no
 * `op`.
 */
export function resolvePassword(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.TERMINUS_PASSWORD;
  if (direct) return direct;

  const ref = env.TERMINUS_PASSWORD_REF;
  if (!ref) {
    throw new Error("Set TERMINUS_PASSWORD_REF (an op:// reference) or TERMINUS_PASSWORD.");
  }

  const result = spawnSync("op", ["read", ref], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Could not run \`op read\` to resolve TERMINUS_PASSWORD_REF: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // op's stderr describes the failure (bad ref, not signed in) and never echoes the secret.
    throw new Error(`\`op read ${ref}\` failed:\n${(result.stderr || "").trim()}`);
  }
  const password = result.stdout.replace(/\n$/, "");
  if (!password) throw new Error(`\`op read ${ref}\` returned nothing.`);
  return password;
}

/**
 * The real status of a body that disagrees with its own status line.
 *
 * Terminus 0.72.0 answers a missing record on `GET /api/devices/:id` and `GET /api/playlists/:id`
 * with **HTTP 200** and an RFC 9457-shaped body that says `"status": 404` — the show actions halt
 * after the response status has already been written. `GET /api/screens/:id` and an unrouted path
 * both return a genuine 404, so this is specific to those two actions rather than the whole API.
 *
 * Without this guard `response.ok` is true and the problem body gets parsed as if it were a
 * record. Returns the status the body claims when it is an error, and null for a normal payload.
 */
export function problemStatus(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if ("data" in body) return null;
  return typeof body.status === "number" && body.status >= 400 ? body.status : null;
}

export interface ClientOptions {
  url: string;
  email: string;
  /** Called only when a fresh login is actually needed, so a cache hit never shells out to `op`. */
  password: () => string;
  /** Absolute or repo-relative path, or null to disable the on-disk cache entirely. */
  tokenCachePath?: string | null;
  fetch?: typeof globalThis.fetch;
  /** Log method, path and status to stderr. Never logs credentials or tokens. */
  verbose?: boolean;
}

interface CachedToken {
  url: string;
  email: string;
  access_token: string;
}

/** Form fields; an array value is repeated, which is how Rack reads `foo[]` into an array. */
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

  constructor(options: ClientOptions) {
    this.url = options.url.replace(/\/$/, "");
    this.email = options.email;
    this.#password = options.password;
    this.#tokenCachePath =
      options.tokenCachePath === undefined ? DEFAULT_TOKEN_CACHE : options.tokenCachePath;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#verbose = options.verbose ?? false;
  }

  /** Build a client from TERMINUS_* environment variables. */
  static fromEnv(
    overrides: Partial<ClientOptions> = {},
    env: NodeJS.ProcessEnv = process.env,
  ): TerminusClient {
    const url = overrides.url ?? env.TERMINUS_URL;
    if (!url) throw new Error("Set TERMINUS_URL (e.g. http://localhost:2300) or pass --url.");
    const email = overrides.email ?? env.TERMINUS_EMAIL;
    if (!email) throw new Error("Set TERMINUS_EMAIL.");
    return new TerminusClient({
      ...overrides,
      url,
      email,
      password: overrides.password ?? (() => resolvePassword(env)),
    });
  }

  /**
   * A usable access token: from memory, then the on-disk cache, then a fresh login.
   *
   * The refresh-token flow is deliberately skipped. A re-login costs one request and carries no
   * rotation state that can go stale when a run is interrupted.
   */
  async accessToken(): Promise<string> {
    if (this.#token && tokenIsUsable(this.#token)) return this.#token;

    const cached = this.#readCachedToken();
    if (cached && tokenIsUsable(cached)) {
      this.#token = cached;
      return cached;
    }

    const token = await this.#login();
    this.#token = token;
    this.#writeCachedToken(token);
    return token;
  }

  async #login(): Promise<string> {
    const path = "/login";
    const response = await this.#fetch(`${this.url}${path}`, {
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
      // A cache entry is only good for the server and account it was minted against.
      if (cached.url !== this.url || cached.email !== this.email) return null;
      return cached.access_token ?? null;
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
    } catch {
      // A cache is an optimisation; failing to write one must not fail the command.
    }
  }

  #log(method: string, path: string, status: number): void {
    if (this.#verbose) process.stderr.write(`${method} ${path} -> ${status}\n`);
  }

  /** An authenticated request with the cookie jar wired in. Callers handle the response. */
  async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("User-Agent", USER_AGENT);
    const cookie = this.jar.header();
    if (cookie) headers.set("Cookie", cookie);

    const response = await this.#fetch(`${this.url}${path}`, { ...init, headers });
    this.jar.store(response.headers);
    this.#log(method, path, response.status);
    return response;
  }

  /**
   * A JSON API call. `Accept: application/json` is set on every one of these.
   *
   * Note that `Accept` alone does not buy a JSON error body from an *unauthenticated* request —
   * Rodauth only switches to JWT mode when an `Authorization` header is present, and without one
   * `/api/...` answers 302 to the login page regardless of `Accept`. Since this client always
   * sends a token, that only matters when the token is rejected, which does come back as JSON.
   */
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

  /** GET an HTML page, for the scrape points and for the CSRF token that comes with them. */
  async html(path: string): Promise<string> {
    const response = await this.request("GET", path, { method: "GET", redirect: "manual" });
    const text = await response.text();
    if (!response.ok) throw new TerminusError("GET", path, response.status, text);
    return text;
  }

  /**
   * A mutating HTML form post, past Hanami's CSRF gate.
   *
   * Fetches `csrfFrom` (the page being posted to, by default) to pick up both the session cookie
   * and the `_csrf_token`, then sends the form URL-encoded with the token included. A 3xx counts
   * as success: Hanami redirects after a successful form submission.
   */
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
