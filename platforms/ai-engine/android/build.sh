#!/bin/sh
# Builds the Android engine libraries (CMakeLists.txt): build.sh <llama.cpp sources> <qwentts.cpp sources> <out dir>
# ANDROID_NDK_HOME: the NDK. Out: libhubai-text.so, libhubai-voice.so (arm64-v8a).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
llama=$1 qwentts=$2 out=$3
mkdir -p "$out"
ndk="-DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 -DANDROID_STL=c++_static -DCMAKE_BUILD_TYPE=Release -DGGML_CPU_ARM_ARCH=armv8.2-a+dotprod+fp16"
gen=$(command -v ninja >/dev/null && echo "-G Ninja" || true)
# text: llama.cpp as a subproject of CMakeLists.txt
cmake -S "$here" -B "$out/build-text" $gen $ndk -DENGINE=text -DUPSTREAM="$llama"
cmake --build "$out/build-text" --target hubai-text -j "$(nproc)"
cp "$out/build-text/libhubai-text.so" "$out/"
# voice: qwentts.cpp's own project, voice.cmake injected
cmake -S "$qwentts" -B "$out/build-voice" $gen $ndk "-DCMAKE_PROJECT_qwentts-ggml_INCLUDE=$here/voice.cmake"
cmake --build "$out/build-voice" --target hubai-voice -j "$(nproc)"
cp "$(find "$out/build-voice" -name libhubai-voice.so | head -1)" "$out/"
ls -la "$out"/*.so
