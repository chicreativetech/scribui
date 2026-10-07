# Releasing ScribUI

A release is a version tag. CI builds the desktop app for macOS, Windows and
Linux, uploads it to a **draft** GitHub release, and you publish the draft.
Publishing is what makes it the update installed apps download.

## Making a release

1. Write the notes in `CHANGELOG.md` under `## <version> (unreleased)`, for
   the people using ScribUI. They become the release notes and what the
   app's update dialog shows.
2. From a clean `main`: `node scripts/release.mjs 0.2.0`. It sets the version
   of the desktop app and the CLI, dates the changelog section, commits
   `Release v0.2.0` and tags `v0.2.0`. It doesn't push.
3. `git push origin main v0.2.0`. The **Release** workflow checks that the tag
   matches the app's version and that the changelog has notes, creates the
   draft, and builds and uploads the installers (dmg and zip for Mac, NSIS for
   Windows, AppImage and .deb for Linux) with the update files
   (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`).
4. Try the installers from the draft, then **Publish release** on GitHub.
   A version with a suffix (`0.2.0-beta.1`) becomes a pre-release, which the
   app's updater doesn't offer.

## Updates

| Installed from | Updates |
|---|---|
| Windows installer | downloads in the background, installs on quit or "Restart to Update" |
| Linux AppImage | same |
| Linux .deb | says a new version is out, links to the release page |
| macOS, Developer ID signed | downloads in the background, installs on quit or "Restart to Update" |
| macOS, unsigned (today's builds) | says a new version is out, links to the release page (macOS only installs signed updates) |
| a development run | no checks |

The app checks 10 s after launch and every 6 hours; Help → Check for Updates…
checks now.

## Signing

Builds sign themselves when these **repository secrets** exist
(Settings → Secrets and variables → Actions); without them they're unsigned,
as before. `electron-builder.config.cjs` holds the logic.

### macOS: Developer ID and notarisation (Apple Developer Program, $99/year)

| Secret | What |
|---|---|
| `MAC_CERT_P12_BASE64` | your **Developer ID Application** certificate with its private key, exported from Keychain Access as .p12, then `base64 -i cert.p12 \| pbcopy` |
| `MAC_CERT_PASSWORD` | the .p12's password |
| `APPLE_ID` | the Apple ID of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | made at account.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | the 10-character team id (developer.apple.com → Membership) |

With the certificate the app is signed with the hardened runtime
(`build/entitlements.mac.plist`: Electron's JIT, and library validation off so
`scribui-sim` can load AXe's Homebrew frameworks); with the Apple ID secrets
too, it's notarised. Signed builds update themselves.

### Windows: Azure Trusted Signing (about $10/month)

| Secret | What |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | an app registration with the *Trusted Signing Certificate Profile Signer* role on the signing account |
| `AZURE_SIGNING_ENDPOINT` | the account's region endpoint, e.g. `https://weu.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | the Trusted Signing account's name |
| `AZURE_SIGNING_PROFILE` | the certificate profile's name |
| `AZURE_SIGNING_PUBLISHER` | the publisher name on the certificate (as validated) |

Unsigned Windows builds work and update; SmartScreen asks once per download.

## Crash reports

They stay on the user's computer: crash dumps (Electron's crash reporter,
never uploaded) and a log in `~/Library/Logs/ScribUI` (macOS) or the app's
data folder `logs/` (Windows, Linux). After a crash the next launch offers to
open a GitHub issue with the version, system and error filled in (the user
sees and edits it before sending) or to show the files. Help → Report a
Problem… and Help → Show Logs and Crash Reports do the same any time.
