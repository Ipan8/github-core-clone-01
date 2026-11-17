# github-core-clone-01

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Ipan8/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Ipan8/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, using only the standard library.
It serves git smart HTTP (upload-pack protocol v0 and v2, receive-pack v0, pkt-line framing,
packfiles with OFS/REF delta resolution), the REST v3 API, a GraphQL v4 executor and an MCP
server over streamable HTTP. All four surfaces read and write one in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. Nothing to install: the
program only imports `node:http`, `node:crypto` and `node:zlib`.
