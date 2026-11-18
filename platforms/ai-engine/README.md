# The local AI engine, a component of the platform

The engine that runs AI models on the device (client docs/plan-ia-moteur.md): not in the AppImage
nor the APK, and no hubby brings it. The app downloads it the first time a hubby needs a model, and
runs it only if the archive's sha256 is the one written here — like the tunnel (platforms/tunnel).

Chosen on a benchmark on the user's devices (docs/plan-ia-moteur.md § 3.8): everything native, one
GPU backend (Vulkan, through ggml), no Python:

| Server | Upstream | For |
|---|---|---|
| `llama-server` | llama.cpp | text (chat, tool calls) |
| `sd-server` | stable-diffusion.cpp | images (a base model and a LoRA) |
| `tts-server` | qwentts.cpp | a voice from a sample |

- `component.json`: the engine version this app expects, the upstream refs it is built from, where
  to get it, and the archive's sha256 per platform. Read by the desktop
  (`platforms/desktop/src/main/ai/component.ts`).
- The archive (`ai-engine-<platform>.tar.gz`): `bin/<server>` (self-contained: ggml and its Vulkan
  backend linked in; it needs the system's Vulkan loader, `libvulkan.so.1`, which GPU drivers
  bring, and the usual OpenSSL 3 and OpenMP (`libgomp.so.1`) libraries
  ), `licenses/`, the `component.json` it was built from.
- Built on Ubuntu 24.04: its glibc (2.39) is older than the desktops it runs on (stable-diffusion.cpp's
  own Linux builds need 2.43).

## A new engine version

1. Bump `version` and `url` here, and the upstream `ref`s to move to.
2. Run the `ai-engine-release` workflow (Actions, workflow_dispatch): it builds the servers and
   publishes the GitHub release `ai-engine-v<version>` with `SHA256SUMS`.
3. Copy the sums into `component.json`, commit: the next app releases expect that engine.

Development: `HUB_AI_ENGINE_DIR=<folder with bin/<server>>` uses locally built servers instead.
