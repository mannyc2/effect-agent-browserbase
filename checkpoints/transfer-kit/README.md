# Historical transfer-kit tooling

`remote-workspace-check.sh` was written to prove that a remote workspace reached
through a filesystem plugin was real and observable: it writes a sentinel, runs a
diagnostic, and records stdout, stderr and a deliberate exit status 7 for a
separate read.

It is kept for the record only. This project no longer moves state through a
remote-desktop plugin or file transfers — see [`../../AGENTS.md`](../../AGENTS.md).
Use `tools/bootstrap.sh` instead.
