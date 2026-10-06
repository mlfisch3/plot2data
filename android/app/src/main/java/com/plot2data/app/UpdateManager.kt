package com.plot2data.app

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.util.Log
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference

/**
 * The "download the APK and hand it to the installer" half of the auto-update
 * feature. Pure plumbing: pick an update up with Android's DownloadManager,
 * then start an `ACTION_VIEW` intent that lets the system installer confirm
 * with the user before anything is written.
 *
 * No URL ever reaches this class without passing [UpdateHttp.isReleaseAssetUrl]
 * first.
 */
class UpdateManager(private val context: Context) {

    private val appContext = context.applicationContext
    private val prefs = UpdatePrefs(appContext)
    private val checker = UpdateChecker()
    private val worker: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val activeDownload = AtomicReference<DownloadReceiver?>(null)

    val isAutoCheckEnabled: Boolean get() = prefs.autoCheckEnabled
    val lastCheckedAt: Long get() = prefs.lastCheckedAt
    val lastResult: String get() = prefs.lastResult

    fun setAutoCheckEnabled(enabled: Boolean) {
        prefs.autoCheckEnabled = enabled
    }

    /**
     * Decide whether to check now. The 24h gate lives on [UpdatePrefs]; this is
     * the gate the launch path consults.
     */
    fun shouldRunStartupCheck(now: Long = System.currentTimeMillis()): Boolean =
        prefs.shouldAutoCheck(now)

    /**
     * Run a check in the background, calling [callback] on the main thread
     * with the result.
     */
    fun checkInBackground(callback: (UpdateResult) -> Unit) {
        worker.execute {
            val result = checker.check()
            prefs.lastCheckedAt = System.currentTimeMillis()
            prefs.lastResult = summarise(result)
            if (result is UpdateResult.Available) {
                prefs.cachedLatestVersion = result.info.versionName
            }
            mainHandler.post { callback(result) }
        }
    }

    /**
     * Download the APK into the app's cache, then hand it to the system
     * installer. [onFinished] fires with success/failure once the install
     * intent has been dispatched (or an error has been reported).
     */
    fun downloadAndInstall(info: UpdateInfo, onFinished: (Boolean) -> Unit) {
        if (!UpdateHttp.isReleaseAssetUrl(info.apkUrl)) {
            Log.w(TAG, "Refused non-GitHub download URL: ${info.apkUrl}")
            toast(R.string.update_download_failed)
            onFinished(false)
            return
        }

        val downloadManager = appContext.getSystemService(DownloadManager::class.java)
        if (downloadManager == null) {
            toast(R.string.update_download_failed)
            onFinished(false)
            return
        }

        val cacheDir = File(appContext.cacheDir, UPDATE_DIR)
        if (!cacheDir.exists() && !cacheDir.mkdirs()) {
            toast(R.string.update_download_failed)
            onFinished(false)
            return
        }
        cacheDir.listFiles()?.forEach { it.delete() }
        val fileName = sanitiseApkName(info.apkName)
        val destination = File(cacheDir, fileName)

        val request = DownloadManager.Request(Uri.parse(info.apkUrl))
            .setTitle(appContext.getString(R.string.update_download_title))
            .setDescription(appContext.getString(R.string.update_download_description, info.versionName))
            .setDestinationUri(Uri.fromFile(destination))
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setMimeType(APK_MIME)
            .addRequestHeader("User-Agent", UpdateHttp.USER_AGENT)
            .addRequestHeader("Accept", "application/octet-stream")

        val downloadId = try {
            downloadManager.enqueue(request)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "DownloadManager rejected request", e)
            toast(R.string.update_download_failed)
            onFinished(false)
            return
        }

        toast(R.string.update_download_started)
        val receiver = DownloadReceiver(downloadId, destination, onFinished)
        activeDownload.set(receiver)
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.RECEIVER_NOT_EXPORTED
        } else {
            0
        }
        ContextCompat.registerReceiver(appContext, receiver, filter, flags)
    }

    /** Cancel any in-flight download and tear down state. Idempotent. */
    fun dispose() {
        activeDownload.getAndSet(null)?.unregister()
        worker.shutdown()
    }

    private fun handleDownloadFinished(id: Long, destination: File, onFinished: (Boolean) -> Unit) {
        val downloadManager = appContext.getSystemService(DownloadManager::class.java)
        val status = downloadManager?.let { queryStatus(it, id) }
        when (status) {
            DownloadManager.STATUS_SUCCESSFUL -> installApk(destination, onFinished)
            else -> {
                Log.w(TAG, "Download failed with status $status")
                toast(R.string.update_download_failed)
                onFinished(false)
            }
        }
    }

    private fun queryStatus(dm: DownloadManager, id: Long): Int? {
        val query = DownloadManager.Query().setFilterById(id)
        dm.query(query)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS)
                if (index >= 0) return cursor.getInt(index)
            }
        }
        return null
    }

    private fun installApk(apk: File, onFinished: (Boolean) -> Unit) {
        if (!apk.exists() || apk.length() <= 0L) {
            toast(R.string.update_download_failed)
            onFinished(false)
            return
        }
        val uri = try {
            FileProvider.getUriForFile(appContext, "${appContext.packageName}.fileprovider", apk)
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "FileProvider rejected the downloaded APK", e)
            toast(R.string.update_download_failed)
            onFinished(false)
            return
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, APK_MIME)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            appContext.startActivity(intent)
            onFinished(true)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "No installer available for APK intent", e)
            toast(R.string.update_install_unsupported)
            onFinished(false)
        } catch (e: SecurityException) {
            Log.w(TAG, "Installer rejected intent", e)
            toast(R.string.update_install_unsupported)
            onFinished(false)
        }
    }

    private fun toast(resId: Int) {
        mainHandler.post {
            Toast.makeText(appContext, resId, Toast.LENGTH_SHORT).show()
        }
    }

    private inner class DownloadReceiver(
        private val id: Long,
        private val destination: File,
        private val onFinished: (Boolean) -> Unit,
    ) : BroadcastReceiver() {

        override fun onReceive(context: Context, intent: Intent) {
            val completed = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            if (completed != id) return
            unregister()
            handleDownloadFinished(id, destination, onFinished)
        }

        fun unregister() {
            try {
                appContext.unregisterReceiver(this)
            } catch (_: IllegalArgumentException) {
                // Already unregistered - fine.
            }
            activeDownload.compareAndSet(this, null)
        }
    }

    companion object {
        private const val TAG = "UpdateManager"
        private const val UPDATE_DIR = "update"
        private const val APK_MIME = "application/vnd.android.package-archive"

        /** Keep the on-disk name tidy and inside one dir; GitHub names are usually sane. */
        internal fun sanitiseApkName(raw: String): String {
            val stripped = raw.substringAfterLast('/').substringAfterLast('\\')
            val safe = stripped.replace(Regex("""[^A-Za-z0-9._-]"""), "_")
            val trimmed = safe.ifEmpty { "update.apk" }
            return if (trimmed.endsWith(".apk", ignoreCase = true)) trimmed else "$trimmed.apk"
        }

        private fun summarise(result: UpdateResult): String = when (result) {
            UpdateResult.UpToDate -> "Up to date"
            is UpdateResult.Available -> "Update available: ${result.info.versionName}"
            is UpdateResult.Failed -> "Check failed: ${result.reason}"
        }
    }
}
