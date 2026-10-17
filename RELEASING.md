# Releasing plot2data

Tag `v<x.y.z>` on `main`.
GitHub Actions builds a signed APK and the single-file review page, then publishes a Release with both attached.
Everything else is prepared before the tag goes up.

## What a release contains

- `plot2data-<x.y.z>.apk` - a signed release APK that installs on top of the previous one.
  The in-app updater downloads this and hands it to the system installer.
- `plot2data-review-<x.y.z>.html` - the self-contained review build, about 5 MB, OCR included.
  Open it on any https host from a browser; see [README.md](README.md).
- Auto-generated release notes with the commit list since the previous `v*` tag and a line
  `plot2data: versionCode=N` that the in-app updater reads to compare the Android `versionCode`.

## Cutting a release

1. **Bump the version in two files, together.**
   - `android/app/build.gradle.kts`: bump `versionCode` by one and set `versionName` to the new semver.
   - `package.json`: set `version` to the same semver.
   - The two Android fields have to move in lockstep: `versionName` drives the semver gate the auto-update checker uses
     and the APK filename; `versionCode` is the integer Android uses at install time to decide whether an APK is an
     upgrade or a downgrade.
2. **Commit the bump** on `main`:
   ```sh
   git commit -am "chore(release): v0.3.0"
   ```
3. **Tag and push.** The tag's `v` prefix is required - the release workflow refuses any other shape.
   ```sh
   git tag v0.3.0
   git push origin main v0.3.0
   ```
4. **Watch the Actions tab.** The `release` workflow runs on the tag, builds the signed APK, extracts the version from it,
   writes a release notes stub and publishes the GitHub Release. The Release page carries the two attached files.
5. **Open the Release page** and add any notes the auto-generated stub did not catch.

The release is a plain GitHub Release the moment the workflow finishes, with the two files attached.
The captain adds narrative notes if he wants; nothing waits on him for the APK to be downloadable.

## Signing

Release APKs are signed with a **stable keystore held in GitHub Actions secrets**, so each tagged APK is signed by the
same identity and installs cleanly on top of the previous one.
Android refuses to install an APK whose signature does not match the installed one, so **the keystore does not get
regenerated per build and does not get rotated without a replacement install plan**.

### Generating the keystore (one-off, by hand)

Done once, by one person, from a trusted machine. The passwords and the alias are chosen here and uploaded as
GitHub Actions secrets.

```sh
keytool -genkey -v \
  -keystore plot2data-release.keystore \
  -keyalg RSA -keysize 4096 -validity 36500 \
  -alias plot2data \
  -storepass '<storepass>' \
  -keypass '<keypass>' \
  -dname 'CN=plot2data, OU=plot2data, O=plot2data, L=-, ST=-, C=--'
```

A 100-year validity is deliberate: Android treats a key with an expired certificate as unusable, and nothing about
rotating one across a userbase is automatic.

### Uploading the secrets

In the repo, open **Settings -> Secrets and variables -> Actions -> New repository secret**, and add four:

| Secret name          | Value                                                                    |
| -------------------- | ------------------------------------------------------------------------ |
| `KEYSTORE_B64`       | `base64 -w 0 plot2data-release.keystore` (the keystore, base64 encoded). |
| `KEYSTORE_PASSWORD`  | The `storepass` above.                                                   |
| `KEY_ALIAS`          | `plot2data` (whatever `-alias` was).                                     |
| `KEY_PASSWORD`       | The `keypass` above.                                                     |

If any one is missing the release workflow fails with a message naming it rather than silently falling back to the
debug key. A debug-key signed APK is a different app to Android and would not install over the previous one.

Keep an offline copy of the keystore and the two passwords. If they are lost the signature is lost - the next release
needs a new application id or has to uninstall and reinstall on every device.

## Verifying before cutting a tag

A dry run from the local tree without touching remote:

```sh
# 1. The lint and unit tests Android CI will run.
npm run android:check

# 2. The release APK; falls back to debug signing locally, which is the right
#    behaviour for a smoke test.
npm run android:apk -- assembleRelease
```

The release workflow re-checks the installed APK against the tag before publishing:
`versionName` must match the tag, and the permission set must be exactly `INTERNET` and `REQUEST_INSTALL_PACKAGES`
(plus AGP's self-declared `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`).

## Rolling back

A bad release is withdrawn by deleting the GitHub Release (or marking it a draft) and tagging the previous
good version at a newer `v<x.y.z>` so the updater offers to roll users forward to it. The updater never prompts a
downgrade and will not do so after a withdrawn release.
