set -eu
SDK=/var/lib/orquester/devices/android-sdk
mkdir -p "$SDK/cmdline-tools" /var/lib/orquester/devices/avd
curl -fsSL --retry 3 -o "$RUNNER_TEMP/cmdline-tools.zip" 'https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip'
sum=$(sha256sum "$RUNNER_TEMP/cmdline-tools.zip" | awk '{ print $1 }')
if [ "$sum" != '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583' ]; then
  echo "::error::cmdline-tools checksum mismatch ($sum)"
  exit 1
fi
rm -rf "$SDK/cmdline-tools/latest" "$RUNNER_TEMP/cmdline-tools"
unzip -q "$RUNNER_TEMP/cmdline-tools.zip" -d "$RUNNER_TEMP"
mv "$RUNNER_TEMP/cmdline-tools" "$SDK/cmdline-tools/latest"
rm -f "$RUNNER_TEMP/cmdline-tools.zip"
SM="$SDK/cmdline-tools/latest/bin/sdkmanager"
yes 2> /dev/null | "$SM" --sdk_root="$SDK" --licenses > /dev/null || true
"$SM" --sdk_root="$SDK" --install 'platform-tools' 'emulator' 'system-images;android-35;google_apis;x86_64'
"$SDK/emulator/emulator" -version | head -1
