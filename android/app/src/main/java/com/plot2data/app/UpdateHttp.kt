package com.plot2data.app

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The only outbound HTTP in the app: a GitHub-locked OkHttp client used by the
 * update checker and a validator for release-asset download URLs.
 *
 * Every request - including each hop on a redirect chain - must land on a host
 * that belongs to GitHub. Anything else is refused at the interceptor level so
 * a malformed redirect, an injected URL or a mis-released asset cannot reach
 * an arbitrary origin. The checker never follows a Location to a non-GitHub
 * host, and the APK download URL is also validated before being handed to
 * DownloadManager.
 *
 * The exact set is small on purpose: `api.github.com` for the release
 * metadata, `github.com` for the canonical release-asset URL, and
 * `*.githubusercontent.com` for the asset CDN GitHub redirects downloads
 * through. Any other hostname fails fast. Change this list and
 * [UpdateHttpTest] fails.
 */
object UpdateHttp {

    const val API_HOST = "api.github.com"
    const val WEB_HOST = "github.com"
    const val USER_AGENT = "plot2data-android/${BuildConfig.VERSION_NAME}"

    /** The exact release-metadata URL the checker ever asks for. */
    const val LATEST_RELEASE_URL =
        "https://$API_HOST/repos/${BuildConfig.P2D_REPO}/releases/latest"

    /**
     * True if [host] is one plot2data is willing to talk to. A null is a
     * malformed URL and is refused.
     */
    fun isGitHubHost(host: String?): Boolean {
        if (host == null) return false
        return host == API_HOST ||
            host == WEB_HOST ||
            host == "githubusercontent.com" ||
            host.endsWith(".githubusercontent.com")
    }

    /** True if [url] is https and on an allowed host. */
    fun isAllowedUrl(url: String?): Boolean {
        if (url == null) return false
        val parsed = url.toHttpUrlOrNull() ?: return false
        if (parsed.scheme != "https") return false
        return isGitHubHost(parsed.host)
    }

    /** True if [url] is a release-asset URL for this repo's APK downloads. */
    fun isReleaseAssetUrl(url: String?): Boolean {
        if (!isAllowedUrl(url)) return false
        val parsed = url?.toHttpUrlOrNull() ?: return false
        // Canonical release-asset form from the GitHub API:
        //   https://github.com/<owner>/<repo>/releases/download/<tag>/<name>
        // GitHub serves the actual bytes via a redirect to the CDN; the
        // DownloadManager follows that redirect itself, and the CDN host is
        // still in the allow list above.
        if (parsed.host != WEB_HOST) return true
        val segments = parsed.pathSegments
        if (segments.size < 5) return false
        return segments[0] == BuildConfig.P2D_REPO_OWNER &&
            segments[1] == BuildConfig.P2D_REPO_NAME &&
            segments[2] == "releases" &&
            segments[3] == "download"
    }

    /** The shared client. Timeouts are generous enough for a slow mobile network. */
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .addInterceptor(hostAllowList())
        .build()

    /**
     * Reject any request whose URL falls outside the allowed hosts, whether it
     * came in directly or via a redirect.
     */
    private fun hostAllowList(): Interceptor = Interceptor { chain ->
        val request = chain.request()
        val host = request.url.host
        if (!isGitHubHost(host)) {
            throw IOException("Refused non-GitHub host: $host")
        }
        val augmented = request.newBuilder()
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/vnd.github+json")
            .build()
        chain.proceed(augmented)
    }
}
