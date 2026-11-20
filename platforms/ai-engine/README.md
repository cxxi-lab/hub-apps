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

## Android

The phone runs the text and the voice engines (client docs/plan-ia-android.md): `android/` builds
llama.cpp's server and qwentts.cpp's as **libraries** (`libhubai-text.so`, `libhubai-voice.so`,
arm64-v8a), since Android runs no executable from an app's files. Each brings its own ggml, linked
in and hidden (only the JNI entry point is exported). The app loads one in its AI process
(`AiService`, `android:process=":ai"`), runs the server's main on a thread, and talks to it over
127.0.0.1 like the desktop does; unbinding ends the process and frees the model's memory.

- `component.json` › `android`: its version, where to get it, each library's sha256 (pinned in the
  APK's BuildConfig, `AiEngineComponent.java`).
- A new version: bump `android.version` and `url`, run the `ai-engine-android-release` workflow,
  copy the sums into `android.files`.
- Locally: `ANDROID_NDK_HOME=… android/build.sh <llama.cpp> <qwentts.cpp> <out>`.

Development: `HUB_AI_ENGINE_DIR=<folder with bin/<server>>` uses locally built servers instead.
