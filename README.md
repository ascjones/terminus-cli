# terminus-cli

A CLI for driving a self-hosted [Terminus](https://github.com/usetrmnl/terminus) server from
scripts instead of clicking its web UI — push a screen's Liquid and its exchange URL, build it,
move playlist items around, and read device and screen state.

**Status: nothing is built yet.** This repo holds the research that establishes how the CLI has to
work, and the API response shapes it will be built on.

[`docs/research/terminus-cli.md`](docs/research/terminus-cli.md) explains how Terminus
authenticates, why Extensions have to go through HTML form posts, the traps that will silently
destroy state, and a proposed command surface. It was verified against a running 0.72.0 server and
is the authority for everything here.

The command is named `terminus`, not `trmnl`: `trmnl` is already the official Terminalwire client
for trmnl.com, which is a different server and cannot talk to Terminus at all.

```sh
npm install
npm run terminus -- devices     # once there is something to run
```
