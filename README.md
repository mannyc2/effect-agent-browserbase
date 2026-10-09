# Temporary: `@yielded/agent` 0.1.0-beta.168

A stand-in for `@yielded/agent@0.1.0-beta.168` until upstream publishes it to npm. Delete this
branch once that version is on npm.

`yielded-agent-0.1.0-beta.168.tgz` is upstream's release candidate, yielded-dev/agent PR #779 at
`36775000a8f4519a7217818c1d16a50cdd43d081` ("chore: version packages (beta)"):

- `dist/`: byte for byte the files upstream's own CI built for that head, from the
  `release-build-37875231062-1` artifact of run 37875231062, each checked against its recorded
  sha256.
- `src/`, `LICENSE`: `packages/effect-agent` at that commit.
- `package.json`: that commit's manifest, with `exports` pointed at `dist/` as upstream's pack
  writes it.

Install it with an override, pinned to a commit of this branch:

```json
"overrides": {
  "@yielded/agent": "https://raw.githubusercontent.com/mannyc2/effect-agent-browserbase/<commit>/yielded-agent-0.1.0-beta.168.tgz"
}
```

sha256 `a5a195f761011861a7d02980609e5802f9d61cd4e5affb2591c87d02515343ee`
