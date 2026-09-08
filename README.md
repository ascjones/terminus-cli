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

A flag wins, then the environment (`TERMINUS_URL`, `TERMINUS_EMAIL`,
`TERMINUS_PASSWORD_COMMAND`, `TERMINUS_SCREENS_DIR`), then the nearest `terminus-cli.json` found
by walking up from the working directory. Paths in it resolve against the file, not the cwd.

```json
{
  "url": "http://localhost:2300",
  "email": "you@example.com",
  "password_command": "your-secret-store read terminus/password",
  "screens": "screens"
}
```

`password_command` is any command that prints the password to stdout — use whatever secret store
you have. It runs only when a login is needed, so the password never sits in the environment. For
CI, set `TERMINUS_PASSWORD` to the password directly instead. The config file is meant to be
committed and refuses a `password` key outright.

A device's `api_key` is redacted from all output, `--json` included.

[`docs/research/terminus-cli.md`](docs/research/terminus-cli.md) explains how Terminus
authenticates and why Extensions need HTML form posts. [MIT](LICENSE).
