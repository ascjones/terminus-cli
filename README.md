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
```

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

The password comes from `TERMINUS_PASSWORD` and nowhere else. If it lives in a secret store,
resolve it in your shell:

```sh
export TERMINUS_PASSWORD=$(your-secret-store read terminus/password)
```

The config file is meant to be committed, so it holds no secret at all and refuses a `password`
key outright.

A device's `api_key` is redacted from all output, `--json` included.

[`docs/research/terminus-cli.md`](docs/research/terminus-cli.md) explains how Terminus
authenticates and why Extensions need HTML form posts. [MIT](LICENSE).
