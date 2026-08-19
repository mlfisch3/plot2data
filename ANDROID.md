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

## Using it from Smart Select

1. Pull out the S Pen and pick **Smart Select** from the Air Command menu, then **Rectangle**.
2. Drag a box round the plot. Include the axes and their tick labels; leave out titles, legends outside the frame and neighbouring panels.
3. Tap **Share** on the Smart Select toolbar and pick **plot2data**.
4. The app opens on the crop step with the image already loaded. Adjust the crop if the selection caught anything extra, then **Extract data**.
5. Check the four markers - X1 and X2 along the bottom, Y1 and Y2 up the side - reading the result off the three panels below them,
   then **Save CSV**, **Save Excel** (both choose where the file goes) or **Share CSV** (send it straight to email, Drive or a spreadsheet).

Three other ways in, all of which work the same once the image is loaded:

- **Open with** from Gallery, Photos or Files.
- Share **several** images at once and the app asks which plot to read.
- The app's own **Browse images** button, and pasting an image from the clipboard.

## What it does, and does not, have access to

- **No network permission.** The app requests nothing, so it cannot reach the network even by mistake. Checked in the built APK: the
  only `uses-permission` in the merged manifest is `<applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`, which AGP injects for
  androidx's own broadcast receivers, is signature-protected and declared by this app about itself. There is no `INTERNET`.
  Everything is served from the APK by the asset loader, whose responses are fulfilled from local streams before the network stack is
  consulted. On top of that, the `WebViewClient` refuses any request the asset loader did not serve, rather than letting it fall through.
- No file access from the WebView (`allowFileAccess` and `allowContentAccess` are off); universal access from file URLs is never enabled.
- A shared image is **copied into the app's cache** and served back to the page over the asset-loader origin.
  A share-sheet URI grant dies with the task that received it, so a copy is what survives the process being killed - and it means the
  WebView never needs content access.
- The only thing that leaves the app is a CSV or a workbook you explicitly save or share. A workbook crosses the bridge base64 encoded,
  because a zip cannot survive the trip as a JavaScript string; the page decides what to export, but not what type the phone files it as -
  anything but the known workbook type is saved as a CSV.

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

## What is verified, and what is not

There was no phone and no emulator available while this was built. Be clear about which claims rest on what.

**Verified:**

- `./gradlew assembleDebug` produces the APK above from a clean checkout.
- The Kotlin unit tests pass (`npm run android:check`): filename sanitising for both export formats, and the escaping of values spliced
  into `evaluateJavascript`.
- Android lint passes with `warningsAsErrors`.
- The APK contains the web bundle at the paths the page asks for - checked file by file against the URLs in the built script, after that
  check caught the asset merger renaming the language data out from under it.
- The whole web layer, driven in desktop Chrome under 412x891 @3.5 device emulation with touch input, against the **module** build served
  over http: the share-target hand-off, the multi-image chooser, insets applied from the host, extraction **with OCR running** (the
  worker, the WASM core and the language data all fetched from the bundle, and the axis values read off the tick labels), the CSV save
  and share calls arriving at a stubbed bridge with the right filename and content, marker drag, pinch-zoom, pan, double-tap-to-fit, and
  back-button step navigation. Portrait and landscape, light and dark.
- Touch targets measured, not assumed: the four markers, the zoom buttons, the sliders, the checkboxes and the linear/log toggle are all
  at least 44px. The last of those was 36px until this pass.
- The three result panels, the linked zoom, the marker-drag magnifier, the per-curve checkboxes and both export formats, in desktop Chrome
  under 412x915 @3.5 device emulation with touch input as well as at 1440x950.
- The `file://` desktop build still behaves as before, OCR skipped with a warning and the markers set by hand - re-checked this pass,
  with the three result panels rendering there too.

**Not verified, because it needs real hardware:**

- That the app installs, launches and renders on a device at all.
- That `WebViewAssetLoader` serves the bundle from the APK in a real WebView - the reasoning and the file-by-file check are good, but no
  request has actually been served.
- **That OCR runs on-device.** It runs in Chrome over the module build, and Android WebView is Chromium, but the WASM core is selected
  from the browser's SIMD support at runtime and no Android WebView has picked one here.
- That the app appears in Samsung's Smart Select share sheet, and that what Smart Select hands over is a readable image.
- `ACTION_CREATE_DOCUMENT` and `ACTION_SEND` actually opening, and the CSV or workbook arriving intact in another app. The workbook route
  is new and has only been exercised as far as the browser: the bytes are known good, because a spreadsheet library reads them back, but no
  Android file picker has been handed one.
- Real touch: finger size, gesture conflicts with system back-gestures at the screen edges, and whether the stage steals scrolls it should not.
- Inset values on the real S24 Ultra, the punch-hole, and the rounded corners.
- Rotation and process-death restore on a real device.
- Performance: a 12-megapixel screenshot through the engine on a phone CPU, and how long the WASM core takes to start.

The first thing to do with a phone attached is run through the Smart Select route end to end and confirm the extraction shows **no**
"Tick labels were not read automatically" warning. That warning is what a silently degraded build looks like.
