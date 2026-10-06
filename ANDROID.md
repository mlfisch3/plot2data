# plot2data on Android

A minimal Kotlin app whose only job is to host the existing web bundle in a WebView.
There is no second implementation of anything: the extraction engine, the UI and the OCR are the same files the browser build uses.

The workflow it is built around: pull the S Pen, drag a rectangle round a plot with Samsung's Smart Select, share the crop to plot2data, get a CSV or an Excel workbook.
Smart Select already does the cropping and already offers a share sheet, so the app registers as a share target and needs no S Pen API at all.

## Building

Needs the Android SDK, a JDK 17 or newer, and the same Node 24 / npm 11 the web build needs.

```sh
npm run android:apk
```

That builds the web bundle in module form, copies it into the app's assets, and assembles the APK.
It lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk     # ~13 MB
```

`tools/android-apk.ts` finds the SDK (`ANDROID_HOME`, then `~/Android/Sdk`) and writes the git-ignored `android/local.properties` itself,
and it finds a JDK 17+ rather than using whatever `java` happens to be on `PATH` - a system default of JDK 11 is too old for a modern
Android Gradle Plugin, and the error it produces says nothing useful. Pass any other Gradle task through it:

```sh
npm run android:check                 # unit tests and lint
npm run android:apk -- assembleRelease
```

`./gradlew assembleDebug` from `android/` works too, given `JAVA_HOME` and `local.properties` are set up by hand.

Toolchain: Gradle 8.9 (wrapper), Android Gradle Plugin 8.6.1, Kotlin 2.0.21, `compileSdk` 35, `minSdk` 26, `targetSdk` 35.
The build is debug-signed.

### Where the web bundle comes from

`npm run build:android` builds into `dist-android/` and syncs that into `android/app/src/main/assets/`.
Both are generated and git-ignored: the app is never a second copy of the page.

It is a **different build from `dist/`**, and deliberately so. `dist/` is a classic script inlined into a single HTML file, because Chrome
blocks ES modules over `file://`. The Android app serves the same code from `WebViewAssetLoader` on `https://appassets.androidplatform.net/`,
which is an ordinary secure context, so it ships as ES modules and - the part that matters - the OCR web worker and its WASM core run.
On the desktop `file://` build they cannot, and the tool says so and asks you to type the marker values in.

## Installing it

Sideloading a debug APK needs installation from unknown sources allowed for whatever is doing the installing.

Over USB, with USB debugging on (Settings → About phone → tap Build number seven times → Developer options → USB debugging):

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Without a cable, copy the APK to the phone and open it from Files. Android will offer to let that app install unknown apps:
Settings → Apps → Special app access → Install unknown apps → Files (or My Files) → Allow.

## Using it from Smart Select (recommended workflow)

This is the primary path and needs no S Pen API at all - Smart Select already crops and offers a share sheet, and plot2data is already registered as a share target.

1. Pull out the S Pen and pick **Smart Select** from the Air Command menu, then **Rectangle**.
2. Drag a box round the plot. Include the axes and their tick labels; leave out titles, legends outside the frame and neighbouring panels.
3. Tap **Share** on the Smart Select toolbar and pick **plot2data** ("Extract data from this plot").
4. The app opens on the crop step with the image already loaded. Adjust the crop if the selection caught anything extra, then **Extract data**.
5. The tool finds the plot frame, reads the tick labels, calibrates the axes and traces the series - all on the phone, with no network.
6. Check the four markers - X1 and X2 along the bottom, Y1 and Y2 up the side - reading the result off the three panels below them,
   then **Save CSV**, **Save Excel** (both choose where the file goes) or **Share CSV** (send it straight to email, Drive or a spreadsheet).

Three other ways in, all of which work the same once the image is loaded:

- **Open with** from Gallery, Photos or Files.
- Share **several** images at once and the app asks which plot to read.
- The app's own **Browse images** button, and pasting an image from the clipboard.

## S Pen integration beyond Smart Select

Smart Select is the recommended workflow because it does the one thing the app cannot do itself: crop a rectangle out of whatever is on screen.
Everything beyond that was investigated.

- **Air Command shortcut.** The user can add plot2data to the Air Command menu manually: Air Command -> "+" (Add shortcuts) -> select plot2data.
  Up to 10 slots are available.
  This is user-configured; no API or manifest entry is needed and no code can add itself there automatically.
- **Air Actions** (S Pen remote gestures, e.g. button press or wave).
  Samsung's S Pen Remote SDK is publicly available with no partner registration.
  An app can register for pen-button actions via an intent filter and a metadata XML.
  However, the gesture vocabulary (single press, double press, swipe up/down/left/right) maps to media-control and presentation-style commands - there is no natural mapping to plot2data's workflow of cropping and dragging markers.
  Not wired; not worth wiring.
- **Air Command built-in tools** (the entries like Smart Select, Screen Write, Create Note).
  There is no public API for an app to register itself as a built-in Air Command tool.
  Those are Samsung's own first-party features.
- **Screen-off memo** (removing the S Pen with the screen off opens a note).
  Not extensible by third-party apps.
- **Samsung S Pen SDK / partner registration.**
  The S Pen Remote SDK (Air Actions) is the only public S Pen SDK, and it does not need partner registration.
  There is no separate SDK for extending Smart Select, Air Command's built-in tools, or any other S Pen surface.

## What it does, and does not, have access to

- **Two permissions, each scoped tightly**, and nothing else.
  Checked in the built APK (`aapt2 dump badging app-debug.apk | grep uses-permission`), the only entries are:
  - `android.permission.INTERNET` - the Kotlin update checker reaches `api.github.com` for the Releases metadata and `github.com`
    (plus the `*.githubusercontent.com` CDN the download redirects through) for the APK. **The WebView itself still refuses every request
    the asset loader does not serve**, so the page cannot touch the network - this permission belongs to the native updater, not the page.
    See [the auto-update section](#auto-update) below.
  - `android.permission.REQUEST_INSTALL_PACKAGES` - required to hand a downloaded APK to the system installer with `ACTION_VIEW`.
    Android still shows the standard "install unknown app" consent prompt before anything is written; this permission does not grant a
    silent install.
  - `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which AGP injects for androidx's own broadcast receivers.
    Signature-protected and declared by this app about itself.
- No file access from the WebView (`allowFileAccess` and `allowContentAccess` are off); universal access from file URLs is never enabled.
- A shared image is **copied into the app's cache** and served back to the page over the asset-loader origin.
  A share-sheet URI grant dies with the task that received it, so a copy is what survives the process being killed - and it means the
  WebView never needs content access.
- The only thing that leaves the app is a CSV or a workbook you explicitly save or share, or a check against the GitHub Releases API.
  A workbook crosses the bridge base64 encoded, because a zip cannot survive the trip as a JavaScript string; the page decides what to
  export, but not what type the phone files it as - anything but the known workbook type is saved as a CSV.

## Auto-update

The app checks the project's [GitHub Releases page](https://github.com/mlfisch3/plot2data/releases) for a newer version.
It is the only network call the app ever makes, and it is strictly scoped: the checker refuses any URL not on `api.github.com`,
`github.com` or `*.githubusercontent.com` at the OkHttp interceptor level
(see `UpdateHttp.kt` and `UpdateHttpTest.kt`), and the download URL has to be a release-asset path for this very repo.

### Flow

1. **On launch**, if the last successful check is more than 24 hours ago, the app hits
   `GET https://api.github.com/repos/mlfisch3/plot2data/releases/latest` in a background coroutine. Nothing more.
2. **A cog in the page's masthead** opens the native settings screen, which has a "Check for updates now" button and the auto toggle.
   This path works offline-friendly: a background check that cannot reach GitHub makes no noise; a manual check that fails shows one line
   that says so.
3. **If a newer version exists**, Android shows a dialog with the installed and available versions and the first few lines of the release
   notes. The two actions are "Install" and "Later"; no auto-install, ever.
4. **Install** downloads the APK with Android's `DownloadManager` into the app's cache dir (`cacheDir/update/`) and hands the completed file
   to `ACTION_VIEW` with the system installer MIME type and a `FileProvider` URI.
   Android shows its standard "install unknown app" prompt before anything is written.
5. **Comparison is by `versionCode`**, not by name. The release workflow writes a tagged line `plot2data: versionCode=N` into the release
   body for the checker to read; semver on the tag is the fallback. A downgrade is never offered.
6. **Rate-limited** to one background check per 24 hours, cached across launches, well under the 60/hour unauthenticated GitHub limit.
   The manual button sits on top of that gate.

### Signatures and upgrades

An APK installs over a previous version only when the two are signed by the same key.
The release workflow signs every tagged APK with the keystore held in `secrets.KEYSTORE_B64` (plus `KEYSTORE_PASSWORD`, `KEY_ALIAS` and
`KEY_PASSWORD`), so one chain of signed APKs upgrades cleanly from v0.2.0 onward.
The debug APK from a local `npm run android:apk` is signed with the AGP debug keystore and is a **different app to Android**: it will
not install over a release-signed version and vice versa.
See [RELEASING.md](RELEASING.md) for how the release keystore is generated and uploaded.

### Turning it off

Open the cog in the masthead, flip **Check for updates automatically**.
The 24h background check stops immediately; the manual button in the same screen still works.
There is no notification channel to disable: nothing is posted outside the dialog shown on the first launch after a new release.

## Phone behaviour

- **Back** walks the workflow - calibrate → crop → start - and only then closes the app. Each step is a history entry, so the same
  presses step through the workflow in a browser too.
- **Rotation** does not restart the activity, so nothing is lost, and the stage keeps its zoom and what it was centred on.
- **Process death** (Android reclaiming a backgrounded app) restores the image from the cached copy, and the crop and export settings
  from the page's own storage, keyed to that image so they are never applied to a different one.
- **Insets**: the system bars, the display cutout and the rounded-corner radius are measured and handed to the page, which pads itself
  accordingly. The keyboard shrinks the WebView so a focused field stays visible.
- **Dark mode** follows the system: the page has its own dark palette, and the WebView is told about the system setting rather than
  being allowed to invert the page itself.
- The stage pinch-zooms and pans, and double-taps between fit and a close look, and so do the two result panels below it; they share a
  zoom by default. Marker knobs are a 44px touch target, and so is every other control on the page.
- Dragging a marker opens a magnifier on the pixels beneath it, in the corner furthest from the finger.

## What is verified

Tested on a Galaxy S24 Ultra (SM-S928U1), Android 16, One UI, Chrome/151.0.7922.169 WebView.

**On the real device:**

- The app installs, launches and renders correctly in both light and dark mode.
- `WebViewAssetLoader` serves the module build from `https://appassets.androidplatform.net/index.html` in a real WebView.
  Confirmed via WebView remote debugging: the page, the CSS, and the worker all load from the asset-loader origin.
- **OCR runs on-device.** The WASM core loads inside the Chrome/151 WebView, the tesseract worker starts, and tick labels are read
  automatically.
  No "Tick labels were not read automatically" warning appears.
  The CSV header marks both calibrations `(ocr)` and reports least-squares fits over 5 x-axis and 4 y-axis labels.
- The app appears in the system share sheet as "plot2data - Extract data from this plot" and accepts shared images via `ACTION_VIEW`
  with content URIs.
- **`ACTION_SEND` intake (the Smart Select path) was not exercised end to end on the device.**
  An `am start` test from the shell delivered the intent and the URI was extracted correctly, but `openInputStream` threw
  `SecurityException` because the shell cannot delegate a MediaStore read grant the way a real share-sheet sender can.
  The app did show a failure toast rather than failing silently.
  The code path is identical to the `ACTION_VIEW` path after URI extraction (same `consume` -> `ingest` -> `deliver` pipeline), and
  `ACTION_VIEW` intake was verified with images that loaded and extracted correctly, so the only untested piece is the URI grant that a
  real Smart Select share carries. The next step is a manual share from Gallery or Smart Select on the device.
- `ACTION_CREATE_DOCUMENT` opens the system file picker for both CSV and Excel.
  The CSV file written is a valid CSV with the full header and calibration metadata (2058 bytes for the panel 1 chart).
  The Excel workbook written is a valid `.xlsx` file (10137 bytes) identified by `file` as "Microsoft Excel 2007+" with the correct
  OOXML structure: two worksheets (data + calibration provenance) and proper content types.
- `ACTION_SEND` share intent works for CSV: the system share sheet opens with the correct filename and the file is offered to all
  installed apps (Drive, WhatsApp, email, etc.).
- Extraction results match the desktop **exactly** for both chart types tested:
  - `01-panel1.png` (curve mode): x 2019.34 to 2024.23, y -171 to 41906, 1 series, 60 points, uncertainty +/-0.0224 in x, +/-349 in y.
  - `02-microprocessor-log-scatter.png` (marker mode): x 1970 to 2020, y 0.200447 to 2.963e+07 (log), 5 series, 194 total points
    (27+26+54+35+52), all five legend names read correctly.
  Both match the calibration, point counts and uncertainty values in ACCURACY.md to the last digit.
- Landscape mode works: the layout adapts with the plot on the left and calibration panel on the right.
  Insets are handled correctly in both orientations, including the punch-hole camera area.
- Dark mode follows the system setting.
  The three plot panels stay on light paper as intended; the chrome around them follows the dark theme.
- **Process death and restore.** The app was backgrounded, killed with `am kill`, and relaunched.
  The image was restored from the cached copy and the crop view reopened with the image loaded and ready for re-extraction.

**From the build, before the device was available:**

- `./gradlew assembleDebug` produces the APK from a clean checkout.
- The Kotlin unit tests pass (`npm run android:check`): filename sanitising for both export formats, and the escaping of values spliced
  into `evaluateJavascript`.
- Android lint passes with `warningsAsErrors`.
- The APK contains the web bundle at the paths the page asks for, checked file by file against the URLs in the built script.
- The whole web layer, driven in desktop Chrome under 412x891 @3.5 device emulation with touch input, against the module build served
  over http: marker drag, pinch-zoom, pan, double-tap-to-fit, and back-button step navigation.
  Portrait and landscape, light and dark.
- Touch targets measured, not assumed: the four markers, the zoom buttons, the sliders, the checkboxes and the linear/log toggle are all
  at least 44px.
- The `file://` desktop build still behaves as before, OCR skipped with a warning and the markers set by hand.

## Test images

Example images from `examples/real/` are pushed to `/sdcard/Download/plot2data-examples/` on the device.
They can be opened from the gallery, file manager, or shared to the app.
