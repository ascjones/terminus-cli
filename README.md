# terminus-cli

A CLI for driving a self-hosted [Terminus](https://github.com/usetrmnl/terminus) server from
scripts instead of clicking its web UI — push a screen's Liquid and its exchange URL, build it,
move playlist items around, and read device and screen state.

**Status: the client and the read-only commands work.** `config`, `devices`, `screens` and
`playlist show` run against a live server. `ext push`, `ext build`, `playlist current` and
`doctor` are not built yet.

[`docs/research/terminus-cli.md`](docs/research/terminus-cli.md) explains how Terminus
authenticates, why Extensions have to go through HTML form posts, the traps that will silently
destroy state, and where the remaining commands are going. It was verified against a running
0.72.0 server and is the authority for everything here.

The command is named `terminus`, not `trmnl`: `trmnl` is already the official Terminalwire client
for trmnl.com, which is a different server and cannot talk to Terminus at all.

## Running it

```sh
npm install
npm run terminus -- devices
npm run terminus -- screens
npm run terminus -- playlist show 2
```

Every command takes `--json` for machine-readable output, plus `--url`, `--email`, `--screens` and
`--verbose`. A device's `api_key` is redacted from all output, `--json` included.

## Settings

A flag wins, then the environment, then the nearest `terminus-cli.json` found by walking up from
the working directory:

```json
{
  "url": "http://localhost:2300",
  "email": "you@example.com",
  "password_ref": "op://Vault/Terminus/password",
  "screens": "screens"
}
```

Put that file in the repo whose screens this CLI pushes, and commit it. Paths inside it resolve
against **the file**, not the working directory, so `"screens": "screens"` means the same directory
whether the command runs from that repo's root, from a subdirectory, or from a launchd timer with
no meaningful cwd. That matters because `ext push` sends whatever it reads to a panel on a wall,
and a bare `./screens` would quietly pick up whichever folder of that name happened to be
underfoot. An unknown key in the file is an error rather than being ignored, so a typo cannot
silently leave a default in place.

`terminus config` prints what was resolved and which source each value came from, which is the
quickest answer to "why is it talking to the wrong server?". It makes no network request, and it
shows a `password_ref` (a pointer) but never a password.

The file must never contain a password — only `password_ref`, and the CLI refuses a `password` key
outright. The equivalent environment variables are `TERMINUS_URL`, `TERMINUS_EMAIL`,
`TERMINUS_PASSWORD_REF`, `TERMINUS_SCREENS_DIR`, and `TERMINUS_PASSWORD` as a fallback for CI or a
machine without the 1Password CLI.

The password is resolved with `op read` only when a login is actually needed, so a cached token
never shells out, and it never enters the environment. The access token is cached in
`build/.terminus-token.json` (mode 0600, git-ignored) and reused until a minute before it expires.

```sh
npm run typecheck
npm run test
```

## Licence

[MIT](LICENSE).
