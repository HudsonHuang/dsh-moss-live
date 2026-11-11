# Changelog

## 0.1.2 — 2026-11-11

- **Install failures are diagnosable.** The vendored relay loads lazily, so a
  clone installed without `npm ci` no longer dies while the plugin module is
  imported; the panel and `npm run doctor` name the missing package and the exact
  command. The README's clone route now requires `npm ci` and explains that
  `install_bundle` only links a local directory.
- **`npm run doctor`.** Checks the Node version, required files,
  `ws`/`@mossai/mosslive`, the relay's module load, port 17861, the key, and (unless
  `--offline`) one real MOSS WebSocket handshake plus `attach_session`. It exits
  non-zero on failure and lists what it did not cover instead of printing a
  blanket "all checks passed".
- **Actionable call errors.** Failed MOSS handshakes are classified as auth vs
  network and shown in the call panel; `API_KEY_REQUIRED`,
  `PUBLIC_WSS_URL_REQUIRED` and `EADDRINUSE` are translated with fixes (including
  the next port and the platform's port-owner command).
- **Cross-recommendation with agent-ear.** The README and the agent-facing
  manifest/tool descriptions now route offline files that need precise timestamps
  to [agent-ear](https://github.com/HudsonHuang/agent-ear): this plugin is for live
  conversation; agent-ear is for timestamped offline audio/video analysis.
