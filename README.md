# terminus-cli

A CLI for driving a self-hosted [Terminus](https://github.com/usetrmnl/terminus) server from
scripts instead of its web UI.

```sh
npm install
npm run terminus -- devices
```

## Commands

```
config                   the resolved settings, and where each came from
devices                  id, label, model, firmware, refresh, battery, synced_at
screens                  id, name, size, bytes, updated_at, and the rendered PNG's URL
playlist show [<id>]     items in order, and which one is current

extension list                      id, name, label, kind
extension show <id|name>            build matrix, exchange URLs, data and errors
extension export <id|name>          download the zip (--out FILE)
extension exchange set <id|name>    --template URL [--headers JSON] [--verb get|post]
extension build <id|name> [--wait]  enqueue a build; --wait polls for the new screen
extension push <dir|zip|name>       update in place by name, or import when it is new
```

`extension push` reads `configuration.yml` and `template.html.liquid` from a directory or a packed
zip — or a bare name, looked up under the `screens` directory — matches the extension **by the
name inside the configuration** (not the filename), and updates
it in place — keeping the build matrix, which a partial update would silently clear. If the name is
new it imports instead, since Terminus's import always creates rather than upserts. It builds
afterwards unless you pass `--no-build`.

`extension exchange set` doubles as an endpoint check: Terminus refreshes an exchange the moment it
is saved, so the command waits for that and prints whether data came back, and the status and body
of any error.

All take `--json`, plus `--url`, `--email`, `--screens` and `--verbose`.

## Settings

A flag wins, then the environment (`TERMINUS_URL`, `TERMINUS_EMAIL`, `TERMINUS_SCREENS_DIR`),
then the nearest `terminus-cli.json` found by walking up from the working directory. Paths in it
resolve against the file, not the cwd.

```json
{
  "url": "http://localhost:2300",
  "email": "you@example.com",
  "screens": "screens"
}
```

The password only ever comes from `TERMINUS_PASSWORD`; the file is meant to be committed, so it
refuses a `password` key. Resolve it in your shell if it lives in a secret store:

```sh
export TERMINUS_PASSWORD=$(your-secret-store read terminus/password)
```

A device's `api_key` is redacted from all output, `--json` included.

[`docs/research/terminus-cli.md`](docs/research/terminus-cli.md) explains how Terminus
authenticates and why Extensions need HTML form posts. [MIT](LICENSE).
