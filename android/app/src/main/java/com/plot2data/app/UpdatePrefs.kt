package com.plot2data.app

import android.content.Context
import android.content.SharedPreferences

/**
 * Durable settings for the auto-update feature. SharedPreferences is enough:
 * the fields are a handful of primitives and the UI never races with itself.
 */
class UpdatePrefs(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    /** The "Check for updates automatically" toggle; on by default. */
    var autoCheckEnabled: Boolean
        get() = prefs.getBoolean(KEY_AUTO, true)
        set(value) = prefs.edit().putBoolean(KEY_AUTO, value).apply()

    /** Wall-clock time of the last successful or failed check, or 0 if never. */
    var lastCheckedAt: Long
        get() = prefs.getLong(KEY_LAST_AT, 0L)
        set(value) = prefs.edit().putLong(KEY_LAST_AT, value).apply()

    /** Short human-readable result of the last check, for display. */
    var lastResult: String
        get() = prefs.getString(KEY_LAST_RESULT, "") ?: ""
        set(value) = prefs.edit().putString(KEY_LAST_RESULT, value).apply()

    /** Cached latest-release metadata, so an offline settings view can still show it. */
    var cachedLatestVersion: String
        get() = prefs.getString(KEY_CACHED_VERSION, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CACHED_VERSION, value).apply()

    /** True when the background check has anything to do right now. */
    fun shouldAutoCheck(now: Long): Boolean {
        if (!autoCheckEnabled) return false
        val last = lastCheckedAt
        if (last <= 0L) return true
        return now - last >= AUTO_CHECK_INTERVAL_MS
    }

    companion object {
        private const val NAME = "plot2data.update"
        private const val KEY_AUTO = "auto"
        private const val KEY_LAST_AT = "last_at"
        private const val KEY_LAST_RESULT = "last_result"
        private const val KEY_CACHED_VERSION = "cached_version"

        /** 24 hours between background checks; the manual button is on top. */
        const val AUTO_CHECK_INTERVAL_MS: Long = 24L * 60L * 60L * 1000L
    }
}
