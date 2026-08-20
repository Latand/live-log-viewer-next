# Vendored: chigwell/telegram-mcp

| Field    | Value |
| -------- | ----- |
| Upstream | https://github.com/chigwell/telegram-mcp |
| Release  | `v3.2.22` |
| Commit   | `a61294362226bd93052f5a40b4a1b1269a99ce69` |
| License  | Apache-2.0 (see `LICENSE` in this directory) |
| Vendored | 2026-08-20 |

## Why vendored instead of installed from PyPI

The `telegram-mcp` name on PyPI belongs to an unrelated project (upstream ships
an install guard for exactly this reason, see `telegram_mcp/install_guard.py`).
The Viewer therefore packages the pinned source release itself, so a clean
installation can provision and start the connector without a manually cloned
checkout and without ever resolving the name through PyPI.

## What is vendored

The runtime source, its license, and its dependency lock:

- `pyproject.toml`, `uv.lock`, `requirements.txt`, `.python-version` — the
  project definition and the exact resolved dependency set at the pinned tag.
- `main.py`, `sanitize.py`, `session_string_generator.py`, `telegram_mcp/` —
  the server implementation.

Upstream tests, screenshots, CI, Docker files, and `.env.example` are not part
of the runtime and are not vendored (the environment contract the Viewer
relies on — `TELEGRAM_EXPOSED_TOOLS=read-only`, `MCP_TRANSPORT=http`,
`MCP_HOST`/`MCP_PORT`, `TELEGRAM_SESSION_STRING` — is documented upstream and
selected by `src/lib/telegram/packaging.ts`). `SHA256SUMS` lists the digest of
every vendored file.

## Verifying against upstream

```sh
git ls-remote https://github.com/chigwell/telegram-mcp refs/tags/v3.2.22
# a61294362226bd93052f5a40b4a1b1269a99ce69

sha256sum -c SHA256SUMS
```

Every vendored file is byte-identical to the file at that commit. Do not patch
files in this directory; connector behavior the Viewer needs (read-only tool
exposure, loopback binding) is selected through environment variables by
`src/lib/telegram/packaging.ts`.
