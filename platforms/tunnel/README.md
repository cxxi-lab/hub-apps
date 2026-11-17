# The tunnel, a component of the platform

The VPN tunnel (a WireGuard client) is not in the AppImage nor the APK, and no hubby brings it: the
app downloads it when a hubby going out through the VPN needs it, and runs it only if its sha256 is
the one written here (server docs/plan-reseau-vpn.md, phase 2).

- `component.json`: the tunnel version this app expects, where to get it, and each file's sha256.
  Read by the desktop (`platforms/desktop/src/main/network/component.ts`) and by the Android build
  (BuildConfig, `TunnelComponent.java`; the Java side, `tunnel.aar`, comes from the same release).
- Files: `wireproxy` (desktop, pufferffish/wireproxy built from source) and `libgojni.so` (Android,
  `platforms/mobile/tunnel` built by gomobile, `scripts/build-tunnel.sh`).

## A new tunnel version

1. Bump `version` (and `wireproxy`, `url`) here.
2. Run the `tunnel-release` workflow (Actions, workflow_dispatch): it builds the files and the
   `tunnel.aar`, and publishes the GitHub release `tunnel-v<version>` with `SHA256SUMS`.
3. Copy the sums into `component.json`, commit: the next app releases expect that tunnel.

Changing `platforms/mobile/tunnel` (the Go side) needs a new tunnel version: the APK's Java side and
the library must come from the same build.
