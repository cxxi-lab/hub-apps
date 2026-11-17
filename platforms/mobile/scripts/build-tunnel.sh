#!/usr/bin/env bash
# Builds the WireGuard tunnel (mobile/tunnel, Go) for Android, split in two:
#  - the Java side the app links against: mobile/android/app/libs/tunnel.aar, WITHOUT its native
#    libraries (the APK carries no tunnel);
#  - the native libraries: mobile/build/tunnel/jni/<abi>/libgojni.so, a component of the platform
#    published by the tunnel-release workflow (platforms/tunnel/README.md), downloaded by the app
#    when a hubby needs the VPN and loaded from there (TunnelComponent, TunnelManager).
# gomobile's Java glue loads the library from the APK (System.loadLibrary("gojni") in go.Seq): it is
# rebuilt here to load the path the app sets in the "cxxi.hub.gojni" system property.
# (Both files gitignored, rebuilt locally and in CI.)
#
# Needs Go, a JDK, ANDROID_HOME, ANDROID_NDK_HOME and gomobile/gobind:
#   go install golang.org/x/mobile/cmd/gomobile@<x/mobile's version in tunnel/go.mod> (and gobind)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$here/android/app/libs/tunnel.aar"
natives="$here/build/tunnel"
mkdir -p "$(dirname "$out")"

cd "$here/tunnel"
# -androidapi matches the app's minSdkVersion (android/variables.gradle).
gomobile bind \
	-target=android/arm64,android/amd64 \
	-androidapi 24 \
	-javapkg cxxi.hub \
	-o "$out" .
rm -f "${out%.aar}-sources.jar"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unzip -q "$out" -d "$work/aar"

# The native libraries go to the module, not the APK.
rm -rf "$natives"
mkdir -p "$natives"
mv "$work/aar/jni" "$natives/jni"

# go.Seq rebuilt to load the library from the path the app gives.
seq_java="$(go list -m -f '{{.Dir}}' golang.org/x/mobile)/bind/java/Seq.java"
mkdir -p "$work/src/go" "$work/classes"
sed 's|System.loadLibrary("gojni");|System.load(System.getProperty("cxxi.hub.gojni"));|' "$seq_java" > "$work/src/go/Seq.java"
grep -q 'cxxi.hub.gojni' "$work/src/go/Seq.java" || { echo "go.Seq: loadLibrary not found, gomobile changed?" >&2; exit 1; }
android_jar="$(ls -d "$ANDROID_HOME"/platforms/android-*/android.jar | sort -V | tail -1)"
(cd "$work/classes" && unzip -q "$work/aar/classes.jar")
rm -f "$work/classes"/go/Seq*.class
javac -nowarn --release 11 -cp "$android_jar:$work/classes" -d "$work/classes" "$work/src/go/Seq.java"
(cd "$work/classes" && rm -f "$work/aar/classes.jar" && zip -qr "$work/aar/classes.jar" .)

rm -f "$out"
(cd "$work/aar" && zip -qr "$out" .)
echo "built $out (no native code) and $natives/jni/*/libgojni.so"
