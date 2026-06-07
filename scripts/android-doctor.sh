#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
app_gradle="$repo_root/android/app/build.gradle"
package_name="com.maverock24.mobilemediaapp"
strict_mode=0
require_public_client_id=0
require_release_signing=0
issues=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict)
      strict_mode=1
      require_public_client_id=1
      ;;
    --require-public-client-id)
      require_public_client_id=1
      ;;
    --require-release-signing)
      require_release_signing=1
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

extract_version() {
  local binary_name="$1"
  local output

  if ! command -v "$binary_name" >/dev/null 2>&1; then
    echo "missing"
    return
  fi

  output="$($binary_name -version 2>&1 | head -n 1)"
  if [[ "$output" =~ \"([0-9]+)\. ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi

  if [[ "$output" =~ ([0-9]+)\. ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi

  echo "unknown"
}

print_header() {
  printf '\n== %s ==\n' "$1"
}

report_issue() {
  issues=$((issues + 1))
  printf 'ISSUE: %s\n' "$1"
}

print_keystore_fingerprints() {
  local keystore_path="$1"
  local alias_name="$2"
  local store_pass="$3"
  local key_pass="$4"
  local label="$5"

  if [[ ! -f "$keystore_path" ]]; then
    echo "$label keystore not found: $keystore_path"
    return
  fi

  if ! command -v keytool >/dev/null 2>&1; then
    echo "keytool not found on PATH; cannot inspect $label keystore."
    return
  fi

  echo "$label keystore: $keystore_path"
  keytool -list -v \
    -alias "$alias_name" \
    -keystore "$keystore_path" \
    -storepass "$store_pass" \
    -keypass "$key_pass" 2>/dev/null \
    | grep -E 'Alias name:|SHA1:|SHA256:|SHA-256:' || true
}

print_header "Android App"
if [[ -f "$app_gradle" ]]; then
  app_id_line="$(grep -E 'applicationId\s+"' "$app_gradle" | head -n 1 || true)"
  if [[ "$app_id_line" =~ \"([^\"]+)\" ]]; then
    package_name="${BASH_REMATCH[1]}"
  fi
fi
printf 'Package name: %s\n' "$package_name"

if [[ -n "${PUBLIC_GOOGLE_CLIENT_ID:-}" ]]; then
  printf 'PUBLIC_GOOGLE_CLIENT_ID: %s\n' "$PUBLIC_GOOGLE_CLIENT_ID"
else
  echo 'PUBLIC_GOOGLE_CLIENT_ID: <unset>'
  if [[ "$require_public_client_id" -eq 1 ]]; then
    report_issue 'PUBLIC_GOOGLE_CLIENT_ID is required for local Google Drive web auth but is not set.'
  fi
fi

print_header "Java Toolchain"
printf 'JAVA_HOME: %s\n' "${JAVA_HOME:-<unset>}"
printf 'java path: %s\n' "$(command -v java || echo '<missing>')"
printf 'javac path: %s\n' "$(command -v javac || echo '<missing>')"
printf 'java version: %s\n' "$(extract_version java)"
printf 'javac version: %s\n' "$(extract_version javac)"

java_version="$(extract_version java)"
javac_version="$(extract_version javac)"
if [[ "$java_version" != "21" || "$javac_version" != "21" ]]; then
  echo
  echo "Android builds in this repo require a full Java 21 JDK."
  echo "Expected: both java and javac report version 21."
  report_issue 'Java 21 JDK is not fully configured (both java and javac must report 21).'
fi

print_header "Debug Signing Fingerprints"
print_keystore_fingerprints "$HOME/.android/debug.keystore" "androiddebugkey" "android" "android" "Debug"

print_header "Release Signing Fingerprints"
if [[ -n "${ANDROID_KEYSTORE_PATH:-}" && -n "${ANDROID_KEY_ALIAS:-}" && -n "${ANDROID_KEYSTORE_PASSWORD:-}" && -n "${ANDROID_KEY_PASSWORD:-}" ]]; then
  print_keystore_fingerprints "$ANDROID_KEYSTORE_PATH" "$ANDROID_KEY_ALIAS" "$ANDROID_KEYSTORE_PASSWORD" "$ANDROID_KEY_PASSWORD" "Release"
else
  echo "Release signing env vars are not fully set."
  echo "Required: ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD"
  if [[ "$require_release_signing" -eq 1 ]]; then
    report_issue 'Release signing env vars are required for release APK builds but are not fully set.'
  fi
fi

print_header "Google Cloud OAuth Checklist"
printf 'Create or update an Android OAuth client for package: %s\n' "$package_name"
echo 'Use the SHA-1 and matching SHA-256 from the same signing key as the installed APK.'
echo 'If debug and release APKs use different keys, create separate Android OAuth client entries.'

print_header "Build Commands"
echo 'pnpm build:mobile'
echo 'pnpm cap:sync:android'
echo 'cd android && ./gradlew assembleDebug --console=plain'

if [[ "$strict_mode" -eq 1 && "$issues" -gt 0 ]]; then
  printf '\nRepo check failed with %s issue(s).\n' "$issues" >&2
  exit 1
fi

if [[ "$strict_mode" -eq 1 ]]; then
  echo
  echo 'Repo check passed.'
fi
