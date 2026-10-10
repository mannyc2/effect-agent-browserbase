# Temporary: `@yielded/agent` 0.1.0-beta.168

A stand-in for `@yielded/agent@0.1.0-beta.168` until upstream publishes it to npm. Keep this
branch while a published `effect-agent-browser` release's README sends consumers here, as
`0.3.0-beta.5`'s does: deleting it would leave the pinned commit unreachable. The address below is
pinned to commit `1c40d56a631ea0a041577d9736a7484e3d0f4b62`, so a later commit here changes
nothing it serves.

`yielded-agent-0.1.0-beta.168.tgz` is upstream's release candidate, yielded-dev/agent PR #779 at
`36775000a8f4519a7217818c1d16a50cdd43d081` ("chore: version packages (beta)"):

- `dist/`: byte for byte the files upstream's own CI built for that head, from the
  `release-build-37875231062-1` artifact of run 37875231062, each checked against its recorded
  sha256.
- `src/`, `LICENSE`: `packages/effect-agent` at that commit.
- `package.json`: that commit's manifest, with `exports` pointed at `dist/` as upstream's pack
  writes it.

Install it as a dependency and as an override, pinned to a commit of this branch, as
`effect-agent-browser`'s README on `main` says:

```json
"dependencies": {
  "@yielded/agent": "https://raw.githubusercontent.com/mannyc2/effect-agent-browserbase/1c40d56a631ea0a041577d9736a7484e3d0f4b62/yielded-agent-0.1.0-beta.168.tgz"
},
"overrides": {
  "@yielded/agent": "https://raw.githubusercontent.com/mannyc2/effect-agent-browserbase/1c40d56a631ea0a041577d9736a7484e3d0f4b62/yielded-agent-0.1.0-beta.168.tgz"
}
```

Integrity `sha512-wEvXIgLTR6nDpFglj/TDI3F2NWgNEhiyXaGaMsbM6vx2H9xFBx/Q90qCcnVRg12kcL4eptuMSZp4wE7YfLxTLw==`,
sha256 `a5a195f761011861a7d02980609e5802f9d61cd4e5affb2591c87d02515343ee`
