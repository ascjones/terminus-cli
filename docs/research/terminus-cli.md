# A CLI for Terminus

Investigation, 7 September 2026. Target: Terminus 0.72.0 (`ghcr.io/usetrmnl/terminus:latest`,
Hanami 3.0.2, Rodauth 2.47.0) running from Docker Compose on `http://localhost:2300`.

> Written against one private deployment and generalised for this repo. Hostnames, credentials,
> MAC addresses and extension names in the examples below are placeholders. The observations they
> illustrate are real, and were taken from a running server on the date above.

Goal: drive Terminus from scripts instead of its web UI — push a screen's Liquid and its exchange
URL, build it, move playlist items around, and read device and screen state. Everything below was
checked against the running server; the facts are from Terminus's own source (`/app` inside
`terminus-web-1`), not from its docs, because the docs cover only part of the surface.

## Summary of the recommendation

Build a small TypeScript CLI (`npm run terminus -- <command>`) over **HTTP only**, using two
transports against the same server:

1. **The JSON API** (`/api/...`) for everything it covers — devices, screens, playlists, models,
   firmware. Documented in `doc/api.adoc`, versioned, and the maintainers announce changes to it.
2. **Session-authenticated HTML form posts** for the Extensions gap. A JWT authenticates these
   routes too; the only extra ingredient is Hanami's CSRF token, which is scraped from the page
   you are about to post to. Proved working below.

Do **not** use SQL. Do **not** use the container console except as a human escape hatch. Reasons in
[Closing the Extensions gap](#closing-the-extensions-gap).

The single most valuable command is `ext push`, which updates an extension **in place** instead of
re-importing it. Re-import always creates a *new* extension, which would orphan the screen the
playlist points at; in-place update keeps screen ids and playlist items intact.

## Prior art: why not use an existing tool

Three official TRMNL repos look like they might save the work. None of them can drive Terminus.

**`usetrmnl/cli`** — unmaintained, and it would not have helped anyway. Five commits, the last in
March 2025; Ruby; 10 stars. More to the point, it is not a client. It is Thor code powered by
[Terminalwire](https://terminalwire.com/), a thin-client protocol where the `trmnl` binary is a dumb
terminal and every command executes *inside trmnl.com's own Rails process*. Its own README says so:
"code inside `lib/` is not intended to run independently of the core TRMNL web server." The source
calls `User.find_by_email`, `Plugin.publicly_available`, `current_user.plugin_settings` and
`Rails.application.message_verifier` — ActiveRecord models that exist on Core and have no
counterpart in Terminus, which is Hanami/ROM and does not bundle Terminalwire (confirmed: no such
gem in `/app/Gemfile.lock`). There is no host to point it at. Its whole surface is `login`,
`whoami`, `version`, `logout`, `plugins ls`, `plugins show` and `go shopping_list` — read-only
listing plus one hardcoded action. Nothing about templates, builds, exchanges, playlists or devices.

**`usetrmnl/trmnlp`** — actively maintained (227 stars, last push August 2026) and much closer in
spirit: a local dev server that previews Liquid against the TRMNL Design System, plus
`trmnlp login` / `push` / `pull` / `build` / `lint`. It even takes a configurable `base_url`
(`lib/trmnlp/config/app.rb`), so pointing it at Terminus looks plausible for a moment. It is not.
Its client talks to `<base_url>/api/plugin_settings`, `/api/plugin_settings/:id/archive` and
`/api/me` with a bearer API key — endpoints Core has and Terminus does not. Probed against our
server:

```
/api/devices                       401     <- route exists, needs auth
/api/me                            404
/api/plugin_settings               404
/api/plugin_settings/1/archive     404
```

Terminus's plugin unit is an *extension* with a different zip layout and no JSON API at all, so
there is nothing for `trmnlp push` to talk to.

Could it still serve as the *preview* half of the job, replacing `npm run preview`? Not as it
stands. Terminus extension templates and Core plugin templates are close cousins with three
incompatible conventions (read from trmnlp's source; not run):

| | Terminus extension | trmnlp / Core plugin |
|---|---|---|
| Polled data | wrapped per exchange as `source_1`, `source_2` (`Exchanges::Coalescer`) | merged at the **top level** of the Liquid scope (`UserDataAssembler#merge_source_data!`) |
| Screen wrapper | the template supplies its own `<div class="screen {{ extension.css_classes }}">` | `render_html.erb` supplies `<div class="screen"><div class="view view--full">`, the template is inner markup only |
| Model sizing | `extension.css_classes` from the model row: `screen--v2 screen--4bit screen--landscape screen--lg screen--density-2x` | `screen_classes` param, default just `screen`; `trmnl.device.width/height` default 800x480 |

All three are shimmable without touching the templates — `.trmnlp.yml` `variables:` can define
`extension.css_classes`, a three-line `src/transform.js` returning `{source_1: input}` reproduces
the Coalescer, and `serve` accepts a `screen_classes` param — but it is a pile of adapter for a
preview we already have.

The genuinely useful thing found while checking: **`.screen--v2` in the framework CSS already
carries the X's whole box** — `--screen-w: 1040px; --screen-h: 780px; --pixel-ratio: 1.8;
--color-depth: 4; --density-tier: 2x`. Terminus's `<style>` injection of those same variables from
the model row is belt-and-braces. A hand-rolled preview harness typically loads **no framework CSS
at all**, faking the panel with `filter: grayscale(1)`. Linking `https://trmnl.com/css/latest/plugins.css`
and putting the real model classes on the `.screen` div is worth more than adopting trmnlp, and it
is independent of the CLI. Doing so surfaced two real divergences a hand-rolled box had been
hiding: the framework applies `padding: var(--gap)` to `.screen`, so templates get 1020x760 rather
than the 1040x780 you would otherwise preview against, and `.screen` carries no font family of its
own, so the panel's Inter came from Terminus's container having Inter installed as a system font
while the local preview silently fell back to Times.

The one thing neither a local preview nor a framework-CSS fix can give is a truly quantised 1-bit/4-bit
dithered PNG — trmnlp has a Firefox + ImageMagick pipeline for that (`build --png --width --height
--color-depth`). But Terminus renders exactly that PNG already, and `terminus screens` below makes
fetching the real one a single command. Ground truth beats a second approximation.

**`usetrmnl/trmnl-api`** — a Ruby client for Core's API, referenced from Terminus's own
`doc/api.adoc` only as the source of canonical model names. Wrong server, wrong language.

So: nothing to adopt, and nothing to wait for. The CLI below is ours to write.

## Authentication

### What a script can obtain

`POST /login` with `Content-Type: application/json` returns JWTs. This is the Rodauth `jwt` +
`jwt_refresh` features (`slices/authentication/middleware.rb`):

```
POST /login  {"login": "...", "password": "..."}
  -> {"access_token": "<JWT>", "refresh_token": "...", "success": "You have been logged in."}
```

Observed claims in the access token (HS256, signed with `APP_SECRET`):

```
account_id, active_session_id, authenticated_by, session_created_at,
last_session_activity_at, iat, nbf, exp
```

**Lifetimes.** `SESSION_EXPIRATION_ENABLED` is unset in the server's environment file, so it defaults to
`true`, which means:

| Token | Lifetime | Knob |
|---|---|---|
| `access_token` | 30 minutes | `API_ACCESS_TOKEN_PERIOD` (seconds) |
| `refresh_token` | 14 days, rotated on each use | not configurable |

`POST /api/jwt` with `Authorization: <access_token>` and `{"refresh_token": "..."}` returns a fresh
pair. Setting `SESSION_EXPIRATION_ENABLED=false` switches `jwt_access_token_period` to
`3_155_760_000` seconds — effectively a 100-year token — but it also turns off inactivity and
lifetime limits for the *browser* session, so the web UI would never log you out either. Not worth
it: a 30-minute token is fine when the CLI logs in per invocation.

### Recommended scheme

**Log in on each invocation and cache the token.** One extra request, no long-lived secret on disk
beyond the password itself, and no refresh-token expiry to babysit. Cache the access token in
`build/.terminus-token.json` (mode 0600, git-ignored) and reuse it while `exp - 60s` is in the
future; fall back to a fresh login. Skip the refresh-token flow entirely — it buys nothing over
re-login and adds rotation state that goes stale if a run is interrupted.

Credentials come from the environment. A command that fetches the password from a secret store is
the preferred form, so nothing is stored in the clear and the password never sits in the
environment:

```sh
TERMINUS_URL=http://localhost:2300
TERMINUS_EMAIL=you@example.com
TERMINUS_PASSWORD_COMMAND='your-secret-store read terminus/password'
# or TERMINUS_PASSWORD=... for CI, where the password is injected directly
```

Any secret store with a CLI that prints the secret to stdout will do.

### Things that bite

- **Rack::Attack safelists the LAN.** `app/providers/rack_attack.rb` safelists `127.0.0.1`, `::1`,
  `10/8`, `172.16/12` and `192.168/16`, and a safelist beats every throttle and blocklist. So from
  a LAN address, the CLI is exempt from both the 300-req/300s IP throttle and the 5-per-minute `/login`
  throttle. It is also exempt from the blank-`User-Agent` blocklist — but set a real
  `User-Agent: terminus-cli/<version>` anyway, so the CLI keeps working if it is ever run from
  outside the LAN.
- **`Accept: application/json` matters.** Without it, an unauthenticated `/api/...` request answers
  `302` to the login page instead of `401` with a JSON body.
- **The JWT authenticates HTML routes too.** `Terminus::Action#authorize` calls
  `rodauth.require_account` for *every* action, and Rodauth's `use_jwt?` is true whenever an
  `Authorization` header is present. Verified: `GET /extensions/1/edit` with only a bearer token
  returns `200`.

Minting a token directly from `APP_SECRET` was considered and rejected. The token carries an
`active_session_id` that Rodauth's `active_sessions` feature ties to a row in
`user_active_session_key`, so a hand-made token is not simply a signing exercise; it is also
undocumented internals, and it would forge a login rather than perform one. Not attempted.

## Closing the Extensions gap

Extensions have **no JSON API**. `config/routes.rb` gives them only HTML routes:

```
GET/POST   /extensions                          index, create
PUT        /extensions/:id                      update            <- the important one
POST       /extensions/import                   import a zip (always creates)
POST       /extensions/:id/build                enqueue a build (202)
GET        /extensions/:id/export               download the zip
GET/POST   /extensions/:id/exchanges            list, create
PUT        /extensions/:id/exchanges/:eid       update URL + headers
GET        /extensions/:id/preview              rendered preview
```

### The four candidate routes, ranked

| Route | Verdict |
|---|---|
| **HTTP form posts** | **Recommended.** Same auth as the JSON API, same process, works remotely, and breaks loudly (a 422 with field errors) rather than silently. |
| Container console | Escape hatch only. `docker exec -i terminus-web-1 bundle exec hanami console` works non-interactively (verified: piping `puts Hanami.app["repositories.extension"].all.map(&:name)` printed `["weather", "calendar"]`). But it depends on DI container keys and repository method names — the least stable surface in the app — needs Docker on the same host, and takes seconds to boot. |
| Direct SQL | Rejected. `config/db/migrate` shows ~20 migrations between May and September 2026, several of them renaming or dropping columns on the very tables we would touch. SQL also skips the Sidekiq jobs that a save triggers, so a template change would never reach a screen. |
| Re-import a zip | Rejected as an *update* mechanism (see below); fine for first creation. |

### Why import cannot be the update path

`Aspects::Extensions::Importers::Local::Creators::Extension` calls `repository.create` — always an
insert, never an upsert, with a `ROM::SQL::UniqueConstraintError` rescued into a "duplicate" error.
So re-importing `weather.zip` either fails or (after deleting the old one) produces a **new
extension id and a new screen id**, orphaning the playlist item that points at the old screen. The
UI dance — import, set the Build Matrix, Save, Build — is a *creation* flow.

The update path is `PUT /extensions/:id`, which is what the Save button does.

### Anatomy of `PUT /extensions/:id`

Body is form-encoded (`Rack::MethodOverride` is on by default in Hanami, so `POST` with
`_method=put` works too, but a real `PUT` is accepted and is what the CLI should send). Fields, from
`Schemas::Extensions::Upsert`:

```
extension[name]                 required   extension[interval]           required (nullable)
extension[label]                required   extension[unit]               optional
extension[description]          required   extension[days][]             optional
extension[kind]                 required   extension[last_day_of_month]  required
extension[mode]                 optional   extension[start_at]           required, datetime
extension[tags]                 required   extension[template]           required (nullable) - the Liquid
extension[static_body]          required   extension[fields]             required (JSON array)
extension[data]                 required   extension[model_ids][]        optional
                                           extension[device_ids][]       optional
```

**The trap:** `Actions::Extensions::Update#update` runs

```ruby
repository.update_with_devices id, attributes, Array(device_ids)
extension = repository.update_with_models id, attributes, Array(model_ids)
```

`Array(nil)` is `[]`, so **omitting `device_ids` clears the build matrix**. On the deployment
studied both extensions built against a single device (`extension_device` had rows `1->2` and
`2->2`; `extension_model` was empty), and a careless push would silently detach them and start
rendering against a model instead. `ext push`
must therefore be read-modify-write, never a partial update.

### Reading the current state before writing it

Two reads, in order of preference:

1. **`GET /extensions/:id/export`** returns a 2-file zip: `configuration.yml` +
   `template.html.liquid`. `configuration.yml` is `Structs::Extension#export_attributes` plus the
   exchanges, i.e. every settings field except the build matrix. This is a real, intended,
   round-trippable format, and a stable thing to keep under version control. Prefer it.
   Note it contains the exchange headers verbatim, **including any API secret**, so anything that
   writes an export back into a repository has to redact them on the way in.
2. **`GET /extensions/:id/edit`** for the build matrix only, which the export omits. Parse the
   selected options out of `select[name="extension[device_ids][]"]` and `...[model_ids][]`
   (`<option value="2" selected="selected">TRMNL`).

Worth correcting if your own notes claim otherwise: the `version:` in `configuration.yml` does
**not** have to match the Terminus release. `Types::Version` only constrains the format to
`\A\d+\.\d+\.\d+\Z`; nothing compares it to the server. A `0.72.0` there happens to match, but a
stale value will not break an import.

### Exchanges are a separate resource

The exchange URL and headers do not live on the extension form. They are
`PUT /extensions/:extension_id/exchanges/:id` with:

```
exchange[template]   the URL (yes, "template")   exchange[headers]  JSON object
exchange[verb]       get | post                  exchange[body]     JSON object
```

Saving enqueues `Jobs::Extensions::ExchangeRefresh` immediately, so a push refreshes the fetched
data as a side effect. The exchange id is scraped from
`GET /extensions/:id/exchanges` (`href="/extensions/1/exchanges/1/edit"`).

### Build is asynchronous

`POST /extensions/:id/build` answers `202` and enqueues `Jobs::Batches::Extension`, which fans out
one `Jobs::Extensions::Screen` per attached device (or per model when no devices are attached), each
of which upserts a screen named `extension-<name>` with label `Extension <label>`
(`Structs::Extension#screen_attributes`). To wait for it, poll `GET /api/screens` for
`name == "extension-<name>"` and watch `updated_at`/`uri` change. There is no job-status endpoint.

Worth knowing: an extension with `unit`/`interval` set already has a sidekiq-scheduler cron entry
(`Structs::Extension#to_schedule`), so ours rebuild every 15 minutes on their own. Explicit `build`
is for "I just changed the template and want to see it now".

### The three HTML scrape points

Everything else is JSON. These are the only places the CLI parses markup, and each should be one
narrow, well-commented regex with a clear error when it finds nothing:

1. Extension id by name — `/extensions`: `<li id="1" class="bit-card extension"> <h2 class="label">Weather</h2>`
2. Exchange id — `/extensions/:id/exchanges`: `href="/extensions/1/exchanges/1/edit"`
3. Build matrix — `/extensions/:id/edit`: selected `<option>`s in the two multi-selects
4. (plus `_csrf_token`, below, on every page we post to)

Give every command an `--id` escape hatch so a markup change never fully blocks a script.

## CSRF: what makes the form posts work

Hanami enables CSRF protection whenever sessions are on, for every non-idempotent method
(`hanami-action/lib/hanami/action/csrf_protection.rb`). `Actions::API::Base` overrides
`verify_csrf_token?` to `false`, which is why the JSON API needs nothing; **HTML actions do not**.

So a mutating HTML request needs three things together:

1. `Authorization: Bearer <access_token>` — the account,
2. the `terminus.session` cookie handed out by any prior GET,
3. `_csrf_token` (form param, or the `X-CSRF-Token` header) matching the token inside that cookie.

The CLI keeps a cookie jar for the process lifetime, GETs the page it is about to post to, lifts
`_csrf_token` out of it, and posts both. Note the session cookie expires after one hour
(`config/app.rb`), which is irrelevant for a one-shot CLI.

## Playlists

`PATCH /api/playlists/:id` is documented and works, but read the action before trusting it
(`Actions::API::Playlists::Patch` + `Repositories::Playlist#update_with_items`):

```ruby
playlist_item.where(playlist_id: id).command(:delete).call if collection
create_items record, collection if collection
```

**Passing `items` deletes every playlist item and recreates it** carrying only
`playlist_id`, `screen_id` and `position`. That silently discards `repeat_type`, `repeat_days`,
`repeat_interval`, `start_at`, `stop_at` and `hidden_at`, and leaves `current_item_id` pointing at a
row that no longer exists. Since those columns are the only place per-item scheduling could live,
this is a live hazard.

Rules for the CLI:

- **`playlist current <screen>`** → `PATCH /api/playlists/:id` with `{playlist: {name, label,
  current_item_id}}` and **never** an `items` key. `name` and `label` are required by the contract,
  so read the playlist first and echo them back.
- **`playlist add <screen>`** → `POST /playlists/:pid/items` with `playlist_item[screen_id]`
  (HTML route). It appends at `max(position) + 1` and sets the playlist's current item to the new
  one.
- **`playlist remove <item>`** → `DELETE /playlists/:pid/items/:id` (HTML route).

### Per-item scheduling does not work

A natural plan is to give a playlist item `repeat_type: daily`, `repeat_days` Mon–Fri and a pair of
`start_at`/`stop_at` windows, so that different screens show at different times of day.
**Terminus 0.72.0 cannot do this.** The columns exist on
`playlist_item`, but `Actions::Playlists::Items::Update` permits exactly one field:

```ruby
required(:playlist_item).hash { required(:screen_id).filled :integer }
```

and the item form (`templates/playlists/items/_fields.html.erb`) renders only the screen select.
There is no API equivalent. The scheduling columns are groundwork for a feature that has not landed.
Until it does, day-part switching has to come from somewhere else — the obvious candidate being the
CLI itself on a cron or launchd timer calling `playlist current`, which is a good argument for
building it.

## Reading state

All three needs are covered by the JSON API:

| Need | Call | Notes |
|---|---|---|
| Devices and `synced_at` | `GET /api/devices` | Also `firmware_version`, `refresh_rate`, `battery_charge`, `wifi_signal`, `width`/`height`. |
| Screens and image URLs | `GET /api/screens` | `uri` is a path (`/uploads/<hash>.png`); join to `TERMINUS_URL`. Note the serializer exposes `name` but **not** `extension_id`, so map screen → extension by the `extension-<name>` convention. |
| Exchange data and errors | *no API* | `GET /extensions/:id/exchanges` (HTML), or the extension's `sources` partial. The underlying `extension_exchange` row has `data`, `errors` and `refreshed_at`. This is the weakest read; consider `ext status` shelling to the export + the exchanges page and reporting `refreshed_at` and whether `errors` is empty. |

## Proposed command surface

```
npm run terminus -- <command>

  devices                          list devices: id, label, model, firmware, refresh, synced_at
  screens                          list screens: id, name, label, w x h, bytes, updated_at, uri
  screen open <name>               open the rendered PNG (or --out <file>)

  ext list                         id, name, label, kind, mode, build matrix
  ext pull <name>                  export zip -> screens/<name>.liquid (+ show config drift)
  ext push <name> [--no-build]     read-modify-write the extension, then the exchange, then build
  ext build <name> [--wait]        POST .../build; --wait polls /api/screens for a new updated_at
  ext status <name>                exchange URL, refreshed_at, errors, top-level data keys
  ext import <zip>                 first-time creation only; refuses if the name already exists

  playlist show [<id>]             items in order, which is current, which screen each points at
  playlist add <screen-name>       append an item
  playlist remove <screen-name>    delete the item
  playlist current <screen-name>   set current_item_id (never touches items)

  raw <METHOD> <path> [json]       authenticated escape hatch, prints status + body

Global: --url, --json (machine-readable output on every command), --verbose
```

`ext push <name>` is the flow that replaces the UI dance, and it is deliberately transactional in
shape:

1. `GET /extensions` → resolve name to id.
2. `GET /extensions/:id/export` → current settings; `GET /extensions/:id/edit` → current
   `device_ids`/`model_ids` and the CSRF token.
3. Merge: local `<screens>/<name>.liquid` becomes `template`; local
   `<screens>/<name>.configuration.yml` (with any placeholder variables substituted) supplies the
   settings; the build matrix is carried over untouched.
4. `PUT /extensions/:id` with the **complete** field set.
5. If the exchange URL or headers changed, `PUT /extensions/:id/exchanges/:eid`.
6. `POST /extensions/:id/build`, then poll `/api/screens` until that screen's `updated_at` moves.

Implementation notes: Node 24 with `--experimental-strip-types`;
`fetch` with a hand-rolled cookie jar (no dependency needed — read `set-cookie`, send `cookie`);
`src/` for the client and `scripts/terminus.ts` for the command dispatch, so the client stays
importable by other programs that might want to nudge a playlist directly.

## Surviving a Terminus upgrade

Terminus is pre-1.0 and its maintainers say breaking changes will happen. Ranked by what breaks
first:

1. **HTML markup** (the three scrape points) — most likely to break, cheapest to fix, and it fails
   visibly. Keep each regex in one file with a comment naming the template it mirrors.
2. **Form field names** (`extension[...]`) — these mirror `Schemas::Extensions::Upsert`. A new
   required field makes `PUT` return 422 with the field name in the body, so surface the response
   body verbatim on failure and the fix is obvious.
3. **The JSON API** — changes are announced, and `doc/api.adoc` ships in the image, so
   `docker exec terminus-web-1 cat /app/doc/api.adoc` diffs cleanly against a pinned copy.
4. **Auth** — Rodauth is a stable dependency; the `/login` + `/api/jwt` shape is the least likely
   thing here to move.

Two cheap defences worth building in:

- **A `terminus doctor` command** that asserts the server version, that each scrape point still
  matches, and that a `PUT` round-trip of an unchanged extension is accepted. Run it after every
  `docker compose pull`. It is the smoke test that turns an upgrade from a surprise into a checklist
  item.
- **Pin `TERMINUS_TAG`** so upgrades are chosen,
  and read the release notes before running `doctor`.

## Worked example: authenticated read against the running server

Ran on 7 September 2026 against `http://localhost:2300`, Terminus 0.72.0. The credentials came from
a secret store and never touched the shell history, the transcript or disk.

**1. Log in and inspect the token.**

```sh
LOGIN=$(your-secret-store read terminus/username)
PASS=$(your-secret-store read terminus/password)
curl -s -X POST http://localhost:2300/login \
     -H 'Content-Type: application/json' -H 'Accept: application/json' \
     -d "$(jq -nc --arg l "$LOGIN" --arg p "$PASS" '{login:$l,password:$p}')"
```

```
keys: ['access_token', 'refresh_token', 'success']
success: You have been logged in.
access_token len: 379   refresh_token len: 47
```

Decoded claims (times local):

```
iat = 2026-09-07T15:37:24    exp = 2026-09-07T16:07:24    <- 30 minutes, as predicted
account_id = 1               active_session_id = <redacted>
authenticated_by = ['password']
```

**2. Read real state with that token.**

```sh
curl -s -H "Authorization: Bearer $TOKEN" -H 'Accept: application/json' \
     http://localhost:2300/api/devices
```

```
id=2  label=TRMNL  mac=AA:BB:CC:DD:EE:FF  model_id=1  playlist_id=2
firmware=1.8.16  refresh_rate=900  1872x1404  synced_at=2026-09-07T14:25:33+00:00
```

`GET /api/screens` in the same breath returned the two extension screens:

```
id=3  extension-weather  Extension Weather  1872x1404  58411 B  /uploads/ae9af99b32ad37e837b8f172afbaa1b7.png
id=4  extension-calendar   Extension Calendar   1872x1404  17935 B  /uploads/2639ff2fb411c1edcd3b12745ca3e0ca.png
```

**3. Prove the risky part — an HTML route, authenticated by JWT, past the CSRF gate.**

This is the bit the whole design rests on, since Extensions have no JSON API.

```sh
# GET the form with only a bearer token: keeps the session cookie, yields the CSRF token.
curl -s -c jar.txt -H "Authorization: Bearer $TOKEN" \
     http://localhost:2300/extensions/1/edit > edit.html          # HTTP 200, 43486 bytes

CSRF=$(grep -o '_csrf_token" value="[^"]*"' edit.html | head -1 | sed 's/.*value="//; s/"$//')
                                                                  # 64 chars

# PUT a NON-EXISTENT extension id, so nothing can be mutated either way.
# Actions::Extensions::Update halts 422 when the record is missing - which it can only
# reach after auth and CSRF have both passed.
curl -s -b jar.txt -X PUT -H "Authorization: Bearer $TOKEN" \
     --data-urlencode "_csrf_token=$CSRF" \
     http://localhost:2300/extensions/999999                       # -> HTTP 422
curl -s -b jar.txt -X PUT -H "Authorization: Bearer $TOKEN" \
     http://localhost:2300/extensions/999999                       # -> HTTP 500 (InvalidCSRFTokenError)
```

`422` with the token and `500` without it is exactly the discrimination we needed: the request
reached the action's own "extension not found" guard, so the JWT satisfied `require_account` on an
HTML route and the scraped token satisfied Hanami's CSRF check. Nothing on the server was modified —
id `999999` does not exist, and the two extensions, the device playlist and every screen were left
untouched throughout this investigation.

The one step not exercised is a *successful* mutating write, which was deliberately left out of a
read-only investigation. Its only untested ingredient is the field set of the form body, and that
fails loudly with a 422 listing the offending fields.

## What to build first

1. `src/terminus/client.ts` — login + token cache, cookie jar, `json()` and `form()` helpers.
2. `devices`, `screens`, `playlist show` — read-only, immediately useful, exercises the auth path.
3. `ext push` + `ext build --wait` — the payoff; retires the import/Save/Build clicking.
4. `playlist current` — enables day-part switching from launchd, which Terminus itself cannot do.
5. `doctor` — before the first `docker compose pull`.
