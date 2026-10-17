package com.plot2data.app

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * What a release looks like after we have decided we care about it. Everything
 * here is already validated: the APK URL lives on a GitHub host, the version
 * is strictly greater than ours, and the asset is one we know how to install.
 */
data class UpdateInfo(
    val versionName: String,
    /** Semver tuple used for the comparison; the tag's `v` prefix is already stripped. */
    val versionTuple: Triple<Int, Int, Int>,
    /** Android versionCode when the release workflow attached its release-info.json; -1 if absent. */
    val versionCode: Int,
    val tag: String,
    val apkUrl: String,
    val apkName: String,
    val apkSize: Long,
    val notes: String,
)

/** The possible outcomes of a check, so the UI can speak plainly about each. */
sealed interface UpdateResult {
    /** The release page has nothing newer than what is installed. */
    data object UpToDate : UpdateResult
    /** A newer release exists and can be downloaded. */
    data class Available(val info: UpdateInfo) : UpdateResult
    /** The check could not complete (offline, 5xx, parse error, host refused). */
    data class Failed(val reason: String) : UpdateResult
}

/**
 * The query half of the auto-update feature: hit `releases/latest` on
 * `api.github.com`, parse what came back, and decide whether to prompt.
 *
 * Pure of Android types so the JVM test suite can exercise it against a mocked
 * HTTP client. The install side (DownloadManager plus the system installer
 * intent) lives in [UpdateManager], where Android is in scope.
 */
class UpdateChecker(
    private val client: OkHttpClient = UpdateHttp.client,
    private val currentVersionName: String = BuildConfig.VERSION_NAME,
    private val currentVersionCode: Int = BuildConfig.VERSION_CODE,
) {

    /**
     * Returns the result of a one-shot query against the Releases API.
     * Blocking; call from a worker thread.
     */
    fun check(): UpdateResult {
        val body = try {
            fetchLatest()
        } catch (e: IOException) {
            return UpdateResult.Failed("Could not reach GitHub (${e.message ?: "network error"})")
        }
        return evaluate(body, currentVersionName, currentVersionCode)
    }

    private fun fetchLatest(): String {
        val request = Request.Builder().url(UpdateHttp.LATEST_RELEASE_URL).get().build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("GitHub returned HTTP ${response.code}")
            }
            val source = response.body?.string()
                ?: throw IOException("Empty response from GitHub")
            return source
        }
    }

    companion object {

        /**
         * Decide, from a raw release JSON body and the installed version
         * (both name and code), whether an update should be offered. Exposed
         * so the test suite can drive it against a canned payload without a
         * running Android stack.
         *
         * The version comparison prefers Android `versionCode` when the
         * release carries a line like
         * `plot2data: versionCode=N` in its body (the release workflow emits
         * one), and falls back to the semver tuple parsed from `tag_name`
         * otherwise. Both are checked: a candidate is only offered when both
         * strictly exceed what is installed. Downgrades are never offered.
         */
        fun evaluate(
            body: String,
            currentVersionName: String,
            currentVersionCode: Int = -1,
        ): UpdateResult = try {
            evaluateOrThrow(body, currentVersionName, currentVersionCode)
        } catch (e: UpdateParseException) {
            UpdateResult.Failed(e.message ?: "Could not read the release information")
        }

        private fun evaluateOrThrow(
            body: String,
            currentVersionName: String,
            currentVersionCode: Int,
        ): UpdateResult {
            val release = try {
                JSONObject(body)
            } catch (_: JSONException) {
                throw UpdateParseException("The release page returned something that is not JSON")
            }
            if (release.optBoolean("draft", false)) {
                return UpdateResult.UpToDate
            }
            if (release.optBoolean("prerelease", false)) {
                return UpdateResult.UpToDate
            }
            val tag = release.optString("tag_name").ifBlank {
                throw UpdateParseException("No tag_name on the release")
            }
            val latestName = tag.removePrefix("v")
            val latest = parseSemver(latestName)
                ?: throw UpdateParseException("Could not parse release tag '$tag' as a version")
            val current = parseSemver(currentVersionName)
                ?: throw UpdateParseException("Could not parse installed version '$currentVersionName'")

            val notes = release.optString("body").trim()
            val latestCode = parseVersionCodeFromBody(notes)

            // Semver ordering is the primary gate. When a versionCode is
            // present on both sides, it must also strictly exceed.
            if (compareTuple(latest, current) <= 0) return UpdateResult.UpToDate
            if (latestCode >= 0 && currentVersionCode >= 0 && latestCode <= currentVersionCode) {
                return UpdateResult.UpToDate
            }

            val assets = release.optJSONArray("assets")
                ?: throw UpdateParseException("No assets on the release")
            var apkUrl: String? = null
            var apkName: String? = null
            var apkSize = 0L
            for (i in 0 until assets.length()) {
                val asset = assets.optJSONObject(i) ?: continue
                val name = asset.optString("name")
                if (!name.endsWith(".apk", ignoreCase = true)) continue
                val url = asset.optString("browser_download_url")
                if (!UpdateHttp.isReleaseAssetUrl(url)) continue
                apkUrl = url
                apkName = name
                apkSize = asset.optLong("size", 0L)
                break
            }
            if (apkUrl == null || apkName == null) {
                throw UpdateParseException("No signed APK is attached to the release yet")
            }
            return UpdateResult.Available(
                UpdateInfo(
                    versionName = latestName,
                    versionTuple = latest,
                    versionCode = latestCode,
                    tag = tag,
                    apkUrl = apkUrl,
                    apkName = apkName,
                    apkSize = apkSize,
                    notes = notes,
                ),
            )
        }

        /**
         * Pulls a `versionCode=NN` out of the release body. The release
         * workflow writes it as a single tagged line so a human reading the
         * notes still finds a note that explains the number.
         */
        internal fun parseVersionCodeFromBody(body: String): Int {
            val match = Regex("""plot2data:\s*versionCode\s*=\s*(\d+)""").find(body)
                ?: return -1
            return match.groupValues[1].toIntOrNull() ?: -1
        }

        /**
         * Parse a `<major>.<minor>.<patch>` string, tolerant of a trailing `-rc1`
         * or `+build` which we treat as the same semver tuple. Returns null if
         * the three leading components cannot be read.
         */
        internal fun parseSemver(value: String): Triple<Int, Int, Int>? {
            val cleaned = value.trim().trimStart('v', 'V')
            val core = cleaned.split('-', '+').first()
            val parts = core.split('.')
            if (parts.size < 3) return null
            val (a, b, c) = parts
            val ai = a.toIntOrNull() ?: return null
            val bi = b.toIntOrNull() ?: return null
            val ci = c.toIntOrNull() ?: return null
            if (ai < 0 || bi < 0 || ci < 0) return null
            return Triple(ai, bi, ci)
        }

        internal fun compareTuple(a: Triple<Int, Int, Int>, b: Triple<Int, Int, Int>): Int {
            if (a.first != b.first) return a.first - b.first
            if (a.second != b.second) return a.second - b.second
            return a.third - b.third
        }
    }
}

/** A parse failure the caller turns into [UpdateResult.Failed]. */
class UpdateParseException(message: String) : RuntimeException(message)
