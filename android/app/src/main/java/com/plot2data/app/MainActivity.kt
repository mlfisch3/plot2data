package com.plot2data.app

import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.view.RoundedCorner
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.util.concurrent.Executors

/**
 * The whole native app: a WebView over the built plot2data bundle, plus the
 * four things a browser tab cannot do on a phone - receive a shared image,
 * write a file the user can find, share that file onward, and sit correctly
 * under the system bars.
 *
 * The page is served from [WebViewAssetLoader] on an https origin rather than
 * from `file://`. That is what makes this build a normal secure context, so the
 * ES-module bundle loads and the offline text recognition (a web worker plus a
 * WASM core) actually runs. Over `file://` Chrome blocks both.
 */
class MainActivity : ComponentActivity() {

    private lateinit var images: SharedImageStore
    private lateinit var webView: WebView
    private lateinit var updates: UpdateManager
    private val io = Executors.newSingleThreadExecutor()

    /** Set once the page has called back to say its receiver is installed. */
    private var pageReady = false

    /** Images waiting for the page to be ready to take them. */
    private var pending: List<SharedImage> = emptyList()

    /** The image currently in the page, kept so a killed process can restore it. */
    private var currentToken: String? = null

    private var insets = PageInsets()

    /** Bytes waiting for the file picker the page just opened. */
    private var pendingBytes: ByteArray? = null

    private val saveCsvLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument(CSV_MIME), ::writePending)

    /**
     * A second launcher, not a second use of the first.
     *
     * `CreateDocument` fixes its MIME type when it is registered, and a
     * workbook offered as `text/csv` gets saved with the wrong type and opens in
     * the wrong app. Registrations must also happen before the activity starts,
     * so this cannot be built on demand.
     */
    private val saveXlsxLauncher = registerForActivityResult(ActivityResultContracts.CreateDocument(XLSX_MIME), ::writePending)

    /** Write whatever the page handed over into the document the user picked. */
    private fun writePending(uri: Uri?) {
        val bytes = pendingBytes
        pendingBytes = null
        if (uri == null || bytes == null) return
        io.execute {
            val ok = writeBytes(uri, bytes)
            runOnUiThread {
                toast(if (ok) R.string.csv_saved else R.string.csv_save_failed)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        images = SharedImageStore(this)
        updates = UpdateManager(this)

        installWebView()
        maybeRunStartupUpdateCheck()

        onBackPressedDispatcher.addCallback(this) {
            if (webView.canGoBack()) {
                // The page pushes a history entry per step, so this walks back
                // through crop -> calibrate rather than closing the app.
                webView.goBack()
            } else {
                isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }

        if (savedInstanceState == null) {
            consume(intent)
            return
        }
        // Coming back from the process being killed. The launch intent is still
        // attached, but its URI grant died with the old task, so re-reading it
        // would only produce a failure toast; the cached copy is what survives.
        savedInstanceState.getString(KEY_TOKEN)?.let { token ->
            io.execute {
                val image = images.find(token)
                runOnUiThread { if (image != null) deliver(listOf(image)) }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        consume(intent)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        currentToken?.let { outState.putString(KEY_TOKEN, it) }
    }

    override fun onDestroy() {
        io.shutdown()
        updates.dispose()
        webView.destroy()
        super.onDestroy()
    }

    /* --------------------------------------------------------------- updates */

    /**
     * Hit the GitHub Releases API in the background if the user has not turned
     * off auto-check and the 24h gate is open. The result is silent on failure
     * - a background check that fails has nothing to say the user did not know
     * already - but shows a dialog when a newer version is available.
     */
    private fun maybeRunStartupUpdateCheck() {
        if (!updates.shouldRunStartupCheck()) return
        updates.checkInBackground { result ->
            if (result is UpdateResult.Available) showUpdateDialog(result.info)
        }
    }

    private fun showUpdateDialog(info: UpdateInfo) {
        if (isFinishing || isDestroyed) return
        val notesExcerpt = info.notes.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .take(10)
            .joinToString("\n")
        val message = buildString {
            append(getString(R.string.update_available_message, BuildConfig.VERSION_NAME, info.versionName))
            if (notesExcerpt.isNotEmpty()) {
                append("\n\n")
                append(notesExcerpt)
            }
        }
        android.app.AlertDialog.Builder(this)
            .setTitle(getString(R.string.update_available_title, info.versionName))
            .setMessage(message)
            .setPositiveButton(R.string.update_install_now) { _, _ ->
                updates.downloadAndInstall(info) {}
            }
            .setNegativeButton(R.string.update_install_later, null)
            .show()
    }

    /* -------------------------------------------------------------- webview */

    private fun installWebView() {
        webView = buildWebView()
        setContentView(webView)
        applyInsetHandling(webView)
        webView.loadUrl(START_URL)
    }

    // The app *is* a JavaScript page. It is served from the asset loader, no other
    // origin can load, and nothing reaches the network, which is what the warning
    // is actually about.
    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val loader = WebViewAssetLoader.Builder()
            .setDomain(ASSET_HOST)
            .addPathHandler(SHARED_PREFIX, images.pathHandler())
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        val view = WebView(this)
        view.layoutParams = ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        view.setBackgroundColor(getColor(R.color.window_background))

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // The page lives on the asset-loader origin and has no business
            // reading the filesystem. Universal access is never turned on; it is
            // off by default and this app does not touch it.
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            mediaPlaybackRequiresUserGesture = true
            // The stage does its own pinch-zoom over the image; letting the
            // WebView zoom the whole document on top of that fights the user.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            useWideViewPort = true
            loadWithOverviewMode = false
            // Assets are replaced wholesale by a rebuild; never serve a stale one.
            cacheMode = WebSettings.LOAD_NO_CACHE
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // The page declares `color-scheme: light dark` and has its own dark
            // palette, so this makes the WebView report the system's dark mode
            // rather than paint an automatic inversion over the top.
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(view.settings, true)
        }

        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val url = request.url
                if (url.scheme == "https" && url.host == ASSET_HOST) {
                    loader.shouldInterceptRequest(url)?.let { return it }
                }
                // Nothing falls through to the network. The app holds no INTERNET
                // permission either, so this is a second lock on the same door.
                return blocked()
            }

            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean = !(request.url.scheme == "https" && request.url.host == ASSET_HOST)

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // A dead renderer takes the whole app process down unless it is
                // handled here. Rebuild and put the image back.
                val token = currentToken
                pageReady = false
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                installWebView()
                if (token != null) {
                    io.execute {
                        val image = images.find(token)
                        runOnUiThread { if (image != null) deliver(listOf(image)) }
                    }
                }
                return true
            }
        }

        view.addJavascriptInterface(Bridge(), BRIDGE_NAME)
        return view
    }

    /* --------------------------------------------------------------- insets */

    private fun applyInsetHandling(view: WebView) {
        ViewCompat.setOnApplyWindowInsetsListener(view) { target, windowInsets ->
            val bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
            // Shrink the WebView itself for the keyboard so the page's own
            // scrolling keeps the focused field visible.
            target.setPadding(0, 0, 0, ime.bottom)

            val density = resources.displayMetrics.density
            insets = PageInsets(
                top = bars.top / density,
                right = bars.right / density,
                bottom = (if (ime.bottom > 0) 0 else bars.bottom) / density,
                left = bars.left / density,
                corner = cornerRadiusPx(windowInsets) / density,
            )
            if (pageReady) pushInsets()
            windowInsets
        }
    }

    /**
     * The largest rounded-corner radius, so the page can keep controls out of
     * the curve. Corners are not part of the inset set; they have their own API.
     */
    private fun cornerRadiusPx(insets: WindowInsetsCompat): Float {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 0f
        val platform = insets.toWindowInsets() ?: return 0f
        val positions = intArrayOf(
            RoundedCorner.POSITION_TOP_LEFT,
            RoundedCorner.POSITION_TOP_RIGHT,
            RoundedCorner.POSITION_BOTTOM_RIGHT,
            RoundedCorner.POSITION_BOTTOM_LEFT,
        )
        return positions.maxOf { platform.getRoundedCorner(it)?.radius ?: 0 }.toFloat()
    }

    private fun pushInsets() {
        call(
            "setInsets({top:${insets.top},right:${insets.right}," +
                "bottom:${insets.bottom},left:${insets.left},corner:${insets.corner}})",
        )
    }

    /* --------------------------------------------------------------- intake */

    private fun consume(intent: Intent?) {
        val uris = imageUris(intent)
        if (uris.isEmpty()) return
        io.execute {
            val ingested = uris.mapNotNull { images.ingest(it) }
            runOnUiThread {
                if (ingested.isEmpty()) toast(R.string.image_read_failed) else deliver(ingested)
            }
        }
    }

    private fun imageUris(intent: Intent?): List<Uri> {
        intent ?: return emptyList()
        return when (intent.action) {
            Intent.ACTION_SEND ->
                listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))

            Intent.ACTION_SEND_MULTIPLE ->
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
                    .orEmpty()
                    .filterNotNull()

            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            else -> emptyList()
        }
    }

    private fun deliver(ingested: List<SharedImage>) {
        pending = ingested
        currentToken = ingested.firstOrNull()?.token
        if (pageReady) flushPending()
    }

    private fun flushPending() {
        if (pending.isEmpty()) return
        val payload = pending.joinToString(",", "[", "]") { image ->
            "{token:${Exports.jsonString(image.token)}," +
                "url:${Exports.jsonString("$APP_ORIGIN$SHARED_PREFIX${image.token}")}," +
                "name:${Exports.jsonString(image.name)}," +
                "mime:${Exports.jsonString(image.mime)}," +
                "bytes:${image.bytes}}"
        }
        pending = emptyList()
        call("receiveImages($payload)")
    }

    /* --------------------------------------------------------------- export */

    private fun writeBytes(uri: Uri, bytes: ByteArray): Boolean = try {
        contentResolver.openOutputStream(uri, "wt").use { output ->
            if (output == null) false else { output.write(bytes); true }
        }
    } catch (e: IOException) {
        false
    } catch (e: SecurityException) {
        false
    }

    private fun shareFile(name: String, bytes: ByteArray, mime: String) {
        val dir = File(cacheDir, "csv")
        io.execute {
            val uri = try {
                dir.listFiles()?.forEach { it.delete() }
                if (!dir.exists() && !dir.mkdirs()) return@execute
                val file = File(dir, name)
                file.writeBytes(bytes)
                FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            } catch (e: IOException) {
                null
            } catch (e: IllegalArgumentException) {
                null
            }
            runOnUiThread {
                if (uri == null) {
                    toast(R.string.csv_save_failed)
                    return@runOnUiThread
                }
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_TITLE, name)
                    putExtra(Intent.EXTRA_SUBJECT, name)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                try {
                    startActivity(Intent.createChooser(send, getString(R.string.share_csv_title)))
                } catch (e: ActivityNotFoundException) {
                    toast(R.string.csv_save_failed)
                }
            }
        }
    }

    /* --------------------------------------------------------------- bridge */

    /**
     * The page's only way into the app.
     *
     * Every method hops to the main thread and re-checks the origin first: an
     * injected interface is visible to whatever document the WebView holds, and
     * this one hands out file writes.
     */
    private inner class Bridge {

        @JavascriptInterface
        fun ready() = onPage {
            pageReady = true
            pushInsets()
            flushPending()
        }

        @JavascriptInterface
        fun saveCsv(name: String?, text: String?) = onPage {
            if (text.isNullOrEmpty()) return@onPage
            save(Exports.safeFileName(name), text.toByteArray(), CSV_MIME)
        }

        @JavascriptInterface
        fun shareCsv(name: String?, text: String?) = onPage {
            if (text.isNullOrEmpty()) return@onPage
            shareFile(Exports.safeFileName(name), text.toByteArray(), CSV_MIME)
        }

        /**
         * The binary export route, for the Excel workbook.
         *
         * A workbook is a zip and cannot survive the trip through a JavaScript
         * string, so it arrives base64 encoded. Only the formats this app knows
         * how to file are accepted: the page decides *what* to export, but not
         * what type the phone believes it is.
         */
        @JavascriptInterface
        fun saveBinary(name: String?, base64: String?, mime: String?) = onPage {
            val bytes = decode(base64) ?: return@onPage
            save(Exports.safeFileName(name, extensionFor(mime)), bytes, mimeFor(mime))
        }

        @JavascriptInterface
        fun shareBinary(name: String?, base64: String?, mime: String?) = onPage {
            val bytes = decode(base64) ?: return@onPage
            shareFile(Exports.safeFileName(name, extensionFor(mime)), bytes, mimeFor(mime))
        }

        /** Opens the native settings/updates screen. The page shows a cog that calls here. */
        @JavascriptInterface
        fun openUpdateSettings() = onPage {
            try {
                startActivity(Intent(this@MainActivity, SettingsActivity::class.java))
            } catch (e: ActivityNotFoundException) {
                toast(R.string.update_download_failed)
            }
        }

        private fun decode(base64: String?): ByteArray? {
            if (base64.isNullOrEmpty()) return null
            return try {
                Base64.decode(base64, Base64.DEFAULT)
            } catch (e: IllegalArgumentException) {
                toast(R.string.csv_save_failed)
                null
            }
        }

        private fun save(name: String, bytes: ByteArray, mime: String) {
            pendingBytes = bytes
            val launcher = if (mime == XLSX_MIME) saveXlsxLauncher else saveCsvLauncher
            try {
                launcher.launch(name)
            } catch (e: ActivityNotFoundException) {
                pendingBytes = null
                toast(R.string.csv_save_failed)
            }
        }

        private inline fun onPage(crossinline body: () -> Unit) {
            runOnUiThread {
                if (webView.url.orEmpty().startsWith(APP_ORIGIN)) body()
            }
        }
    }

    /* ---------------------------------------------------------------- utils */

    private fun call(expression: String) {
        webView.evaluateJavascript("window.__p2dHost&&window.__p2dHost.$expression;", null)
    }

    private fun toast(resId: Int) {
        Toast.makeText(this, resId, Toast.LENGTH_SHORT).show()
    }

    private data class PageInsets(
        val top: Float = 0f,
        val right: Float = 0f,
        val bottom: Float = 0f,
        val left: Float = 0f,
        val corner: Float = 0f,
    )

    private companion object {
        const val ASSET_HOST = "appassets.androidplatform.net"
        const val APP_ORIGIN = "https://$ASSET_HOST"
        const val START_URL = "$APP_ORIGIN/index.html"
        const val SHARED_PREFIX = "/shared/"
        const val BRIDGE_NAME = "Plot2DataAndroid"
        const val CSV_MIME = "text/csv"
        const val XLSX_MIME =
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

        /** Anything the page asks for that is not a known workbook is a CSV. */
        fun mimeFor(mime: String?): String = if (mime == XLSX_MIME) XLSX_MIME else CSV_MIME

        fun extensionFor(mime: String?): String =
            if (mime == XLSX_MIME) Exports.XLSX_EXTENSION else Exports.CSV_EXTENSION
        const val KEY_TOKEN = "plot2data.image.token"

        fun blocked(): WebResourceResponse = WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Blocked",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0)),
        )
    }
}
