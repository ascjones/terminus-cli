import { describe, expect, it } from "vitest";
import {
  connectionDetail,
  CookieJar,
  TerminusClient,
  TerminusError,
  extractCsrfToken,
  jwtExpiry,
  problemStatus,
  resolvePassword,
  tokenIsUsable,
} from "./client.ts";

/** A JWT-shaped string whose `exp` claim is the given offset from now. Not signed; nothing here verifies. */
function fakeToken(expiresInSeconds: number): string {
  const claims = { exp: Math.floor(Date.now() / 1000) + expiresInSeconds, account_id: 1 };
  return `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/** A fetch stub that records every call and replays a queue of responses. */
function stubFetch(responses: Response[]): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${String(input)}`);
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function loginResponse(token: string): Response {
  return new Response(JSON.stringify({ access_token: token, refresh_token: "r", success: "ok" }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": "terminus.session=abc123; path=/; httponly" },
  });
}

function client(responses: Response[]) {
  const { fetch, calls } = stubFetch(responses);
  return {
    calls,
    client: new TerminusClient({
      url: "http://localhost:2300/",
      email: "a@example.com",
      password: () => "secret",
      tokenCachePath: null,
      fetch,
    }),
  };
}

describe("CookieJar", () => {
  it("keeps the latest value of each cookie and renders one Cookie header", () => {
    const jar = new CookieJar();
    jar.store(new Headers([["set-cookie", "terminus.session=one; path=/; httponly"]]));
    jar.store(new Headers([["set-cookie", "terminus.session=two; path=/"], ["set-cookie", "other=x"]]));
    expect(jar.header()).toBe("terminus.session=two; other=x");
  });

  it("has no header until it has a cookie", () => {
    expect(new CookieJar().header()).toBeUndefined();
  });
});

describe("extractCsrfToken", () => {
  it("lifts the token out of Hanami's hidden input", () => {
    const html = `<form><input type="hidden" name="_csrf_token" value="${"a".repeat(64)}"></form>`;
    expect(extractCsrfToken(html)).toBe("a".repeat(64));
  });

  it("throws rather than posting a request that would be rejected as a bare 500", () => {
    expect(() => extractCsrfToken("<form></form>")).toThrow(/No _csrf_token/);
  });
});

describe("token lifetime", () => {
  it("reads the exp claim", () => {
    expect(jwtExpiry(fakeToken(1800))).toBeGreaterThan(Date.now() / 1000);
    expect(jwtExpiry("not-a-jwt")).toBeNull();
  });

  it("treats a token inside the safety margin as unusable", () => {
    expect(tokenIsUsable(fakeToken(1800))).toBe(true);
    expect(tokenIsUsable(fakeToken(30))).toBe(false);
    expect(tokenIsUsable(fakeToken(-1))).toBe(false);
  });
});

describe("problemStatus", () => {
  // Terminus 0.72.0 answers a missing device or playlist with HTTP 200 and a body saying 404.
  it("reports the status an error body claims", () => {
    expect(problemStatus({ type: "about:blank", title: "Not Found", status: 404 })).toBe(404);
  });

  it("leaves normal payloads alone", () => {
    expect(problemStatus({ data: [{ id: 1 }] })).toBeNull();
    expect(problemStatus({ data: { id: 1, status: 404 } })).toBeNull();
    expect(problemStatus([{ id: 1 }])).toBeNull();
  });
});

describe("TerminusClient.accessToken", () => {
  it("logs in once and reuses the token", async () => {
    const token = fakeToken(1800);
    const { client: c, calls } = client([
      loginResponse(token),
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ]);

    await c.json("GET", "/api/devices");
    await c.json("GET", "/api/screens");

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://localhost:2300/login",
      "GET http://localhost:2300/api/devices",
      "GET http://localhost:2300/api/screens",
    ]);
    expect(calls[1]?.headers.get("authorization")).toBe(`Bearer ${token}`);
  });

  it("never puts the password anywhere but the login body", async () => {
    const { client: c, calls } = client([
      loginResponse(fakeToken(1800)),
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ]);
    await c.json("GET", "/api/devices");

    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ login: "a@example.com", password: "secret" });
    expect(calls[1]?.body).toBeNull();
    expect([...(calls[1]?.headers ?? [])].map(([, value]) => value).join(" ")).not.toContain("secret");
  });
});

describe("TerminusClient.json", () => {
  it("throws with the body verbatim on a failing status", async () => {
    const { client: c } = client([
      loginResponse(fakeToken(1800)),
      new Response('{"status":422,"errors":{"name":["is missing"]}}', { status: 422 }),
    ]);

    const error = await c.json("GET", "/api/devices").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerminusError);
    expect((error as TerminusError).status).toBe(422);
    expect((error as TerminusError).report).toContain('"name":["is missing"]');
  });

  it("throws on a 200 whose body claims an error status", async () => {
    const { client: c } = client([
      loginResponse(fakeToken(1800)),
      new Response('{"type":"about:blank","title":"Not Found","status":404}', { status: 200 }),
    ]);

    const error = await c.json("GET", "/api/playlists/999").catch((e: unknown) => e);
    expect((error as TerminusError).status).toBe(404);
  });
});

describe("TerminusClient.form", () => {
  it("scrapes the CSRF token from the page and posts it with the session cookie", async () => {
    const { client: c, calls } = client([
      loginResponse(fakeToken(1800)),
      new Response(`<input name="_csrf_token" value="${"f".repeat(64)}">`, {
        status: 200,
        headers: { "set-cookie": "terminus.session=page-cookie; path=/" },
      }),
      new Response("", { status: 302, headers: { location: "/extensions/1" } }),
    ]);

    const result = await c.form("PUT", "/extensions/1", {
      "extension[name]": "weather",
      "extension[device_ids][]": ["2", "3"],
    });

    expect(result.status).toBe(302);
    const put = calls[2];
    const sent = new URLSearchParams(put?.body ?? "");
    expect(sent.get("_csrf_token")).toBe("f".repeat(64));
    // Repeated keys are how Rack reads `foo[]` into an array; the build matrix depends on it.
    expect(sent.getAll("extension[device_ids][]")).toEqual(["2", "3"]);
    expect(put?.headers.get("cookie")).toBe("terminus.session=page-cookie");
  });

  it("can take the CSRF token from a different page than the one it posts to", async () => {
    const { client: c, calls } = client([
      loginResponse(fakeToken(1800)),
      new Response(`<input name="_csrf_token" value="${"e".repeat(64)}">`, { status: 200 }),
      new Response("", { status: 302 }),
    ]);

    await c.form("PUT", "/extensions/999999", {}, { csrfFrom: "/extensions/1/edit" });

    expect(calls[1]?.url).toBe("http://localhost:2300/extensions/1/edit");
    expect(calls[2]?.url).toBe("http://localhost:2300/extensions/999999");
  });
});

describe("resolvePassword", () => {
  it("prefers the literal password when one is set, without shelling out", () => {
    expect(resolvePassword({ TERMINUS_PASSWORD: "literal", TERMINUS_PASSWORD_REF: "op://x/y/z" })).toBe("literal");
  });

  it("prefers a literal password over any reference, without shelling out", () => {
    expect(resolvePassword({ TERMINUS_PASSWORD: "literal" }, "op://Vault/item/password")).toBe("literal");
  });

  it("names every source when there is none", () => {
    expect(() => resolvePassword({})).toThrow(
      /TERMINUS_PASSWORD_REF.*terminus-cli\.json.*TERMINUS_PASSWORD/s,
    );
  });
});

describe("connectionDetail", () => {
  it("digs the real reason out of undici's nested rejection", () => {
    const refused = new Error("connect ECONNREFUSED ::1:9999");
    const failed = new TypeError("fetch failed", { cause: new AggregateError([refused], "") });
    expect(connectionDetail(failed)).toContain("ECONNREFUSED");
  });

  it("falls back to the outer message when there is nothing nested", () => {
    expect(connectionDetail(new Error("boom"))).toBe("boom");
  });
});
