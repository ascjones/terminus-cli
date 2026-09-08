# terminus-cli

A CLI for driving a self-hosted [Terminus](https://github.com/usetrmnl/terminus) server from
scripts instead of clicking its web UI — push a screen's Liquid and its exchange URL, build it,
move playlist items around, and read device and screen state.

**Status: the client and the read-only commands work.** `devices`, `screens` and
`playlist show` run against a live server; `ext push`, `playlist current` and `doctor` are not
built yet. See the research document for the ship order.

[`docs/research/terminus-cli.md`](docs/research/terminus-cli.md) explains how Terminus
authenticates, why Extensions have to go through HTML form posts, the traps that will silently
destroy state, and a proposed command surface. Verified against a running 0.72.0 server; it is the
authority for everything here.

The command is named `terminus`, not `trmnl`: `trmnl` is already the official Terminalwire client
for trmnl.com, which is a different server and cannot talk to Terminus at all.

## Running it

```sh
npm install

export TERMINUS_URL=http://localhost:2300
export TERMINUS_EMAIL=you@example.com
export TERMINUS_PASSWORD_REF='op://Vault/Terminus/password'
# or TERMINUS_PASSWORD=... for CI or a machine without the 1Password CLI

npm run terminus -- devices
npm run terminus -- screens
npm run terminus -- playlist show 2
```

The password is resolved with `op read` only when a login is actually needed, and never enters the
environment. The access token is cached in `build/.terminus-token.json` (mode 0600, git-ignored)
and reused until a minute before it expires.

Every command takes `--json` for machine-readable output, plus `--url`, `--email` and `--verbose`.
A device's `api_key` is redacted from all output, `--json` included.

```sh
npm run typecheck
npm run test
```
