package com.plot2data.app

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.UUID

/** One image the app has taken a copy of, addressable from the page by [token]. */
data class SharedImage(
    val token: String,
    val name: String,
    val mime: String,
    val bytes: Long,
)

/**
 * Holds the images handed to the app by a share, an "open with", or the app's
 * own restore path, and serves them back to the page over the asset-loader
 * origin.
 *
 * Incoming `content://` URIs are **copied into the cache** rather than kept as
 * URIs. A share-sheet grant lasts only as long as the task that received it, so
 * a URI held across process death is dead; a copy is not. It also keeps the
 * WebView from ever needing `allowContentAccess`.
 */
class SharedImageStore(context: Context) {

    private val resolver = context.contentResolver
    private val dir = File(context.cacheDir, DIR_NAME)

    /** Copy [uri] into the cache. Blocking: call from a background thread. */
    fun ingest(uri: Uri): SharedImage? {
        if (!dir.exists() && !dir.mkdirs()) return null
        val token = UUID.randomUUID().toString().replace("-", "")
        val target = File(dir, "$token.bin")
        val written = try {
            resolver.openInputStream(uri).use { input ->
                if (input == null) return null
                target.outputStream().use { output -> input.copyTo(output) }
            }
            target.length()
        } catch (e: IOException) {
            target.delete()
            return null
        } catch (e: SecurityException) {
            target.delete()
            return null
        }
        if (written <= 0L) {
            target.delete()
            return null
        }

        val mime = sniffMime(target) ?: resolver.getType(uri) ?: DEFAULT_MIME
        // The metadata file is line-based, so a name may not contain a line break.
        val name = displayName(uri)?.replace(WHITESPACE, " ")?.trim()?.takeIf { it.isNotEmpty() }
            ?: defaultNameFor(mime)
        val image = SharedImage(token, name, mime, written)
        File(dir, "$token.meta").writeText("${image.mime}\n${image.name}")
        prune()
        return image
    }

    /** Look an image up again, including after the process was restarted. */
    fun find(token: String): SharedImage? {
        if (!Exports.isValidToken(token)) return null
        val blob = File(dir, "$token.bin")
        val meta = File(dir, "$token.meta")
        if (!blob.isFile || !meta.isFile) return null
        val lines = try {
            meta.readLines()
        } catch (e: IOException) {
            return null
        }
        val mime = lines.getOrNull(0)?.takeIf { it.isNotBlank() } ?: DEFAULT_MIME
        val name = lines.getOrNull(1)?.takeIf { it.isNotBlank() } ?: defaultNameFor(mime)
        return SharedImage(token, name, mime, blob.length())
    }

    /**
     * Serves `/<prefix>/<token>` from the cached copy.
     *
     * Called on a background thread by the WebView, so it does its own IO.
     */
    fun pathHandler(): WebViewAssetLoader.PathHandler = WebViewAssetLoader.PathHandler { path ->
        val token = path.substringBefore('?').substringBefore('#').trim('/')
        val image = find(token) ?: return@PathHandler notFound()
        try {
            WebResourceResponse(
                image.mime,
                null,
                200,
                "OK",
                mapOf("Cache-Control" to "no-store", "Content-Length" to image.bytes.toString()),
                FileInputStream(File(dir, "$token.bin")),
            )
        } catch (e: IOException) {
            notFound()
        }
    }

    /** Keep the working set small; the captain only ever looks at one plot at a time. */
    private fun prune(keep: Int = KEEP) {
        val blobs = dir.listFiles { f -> f.name.endsWith(".bin") } ?: return
        if (blobs.size <= keep) return
        blobs.sortedByDescending { it.lastModified() }
            .drop(keep)
            .forEach { blob ->
                val token = blob.name.removeSuffix(".bin")
                blob.delete()
                File(dir, "$token.meta").delete()
            }
    }

    private fun displayName(uri: Uri): String? = try {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0)?.takeIf { it.isNotBlank() } else null
        }
    } catch (e: SecurityException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }

    private companion object {
        val WHITESPACE = Regex("\\s+")
        const val DIR_NAME = "shared"
        const val DEFAULT_MIME = "image/png"
        const val KEEP = 3

        fun notFound(): WebResourceResponse = WebResourceResponse(
            "text/plain",
            "utf-8",
            404,
            "Not Found",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0)),
        )

        fun defaultNameFor(mime: String): String = when (mime) {
            "image/jpeg" -> "shared-image.jpg"
            "image/webp" -> "shared-image.webp"
            else -> "shared-image.png"
        }

        /**
         * Trust the bytes over the sender's claimed type. Share sheets often
         * hand over a wildcard image type, or `application/octet-stream`, and
         * the page picks its export filename from what we say this is.
         */
        fun sniffMime(file: File): String? {
            val head = ByteArray(12)
            val read = try {
                FileInputStream(file).use { it.read(head) }
            } catch (e: IOException) {
                return null
            }
            if (read < 12) return null
            fun at(offset: Int, vararg bytes: Int) =
                bytes.withIndex().all { (i, b) -> head[offset + i] == b.toByte() }
            return when {
                at(0, 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) -> "image/png"
                at(0, 0xFF, 0xD8, 0xFF) -> "image/jpeg"
                at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50) -> "image/webp"
                else -> null
            }
        }
    }
}
