package com.plot2data.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the version comparison and the parse decisions. The checker drives the
 * installer flow, so an off-by-one here would either nag users forever or
 * silently drop a real update.
 */
class UpdateCheckerTest {

    private fun release(
        tag: String,
        apkUrl: String = "https://github.com/mlfisch3/plot2data/releases/download/$tag/plot2data-${tag.removePrefix("v")}.apk",
        apkName: String = "plot2data-${tag.removePrefix("v")}.apk",
        prerelease: Boolean = false,
        draft: Boolean = false,
        notes: String = "- fixed a crash\n- faster peaks",
        size: Long = 13_000_000,
    ): String = """
        {
          "tag_name": "$tag",
          "prerelease": $prerelease,
          "draft": $draft,
          "body": ${quote(notes)},
          "assets": [
            {"name": "plot2data-review-${tag.removePrefix("v")}.html", "browser_download_url": "https://github.com/mlfisch3/plot2data/releases/download/$tag/plot2data-review-${tag.removePrefix("v")}.html", "size": 5300000},
            {"name": "$apkName", "browser_download_url": "$apkUrl", "size": $size}
          ]
        }
    """.trimIndent()

    private fun quote(s: String): String =
        '"' + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + '"'

    @Test
    fun `offers newer semver`() {
        val result = UpdateChecker.evaluate(release("v0.3.0"), "0.2.0")
        assertTrue(result is UpdateResult.Available)
        val info = (result as UpdateResult.Available).info
        assertEquals("0.3.0", info.versionName)
        assertEquals("plot2data-0.3.0.apk", info.apkName)
        assertEquals(13_000_000L, info.apkSize)
        assertTrue(info.notes.contains("fixed a crash"))
    }

    @Test
    fun `up to date when versions match`() {
        val result = UpdateChecker.evaluate(release("v0.2.0"), "0.2.0")
        assertEquals(UpdateResult.UpToDate, result)
    }

    @Test
    fun `never prompts a downgrade`() {
        val result = UpdateChecker.evaluate(release("v0.1.9"), "0.2.0")
        assertEquals(UpdateResult.UpToDate, result)
    }

    @Test
    fun `ignores prereleases`() {
        val result = UpdateChecker.evaluate(release("v0.3.0", prerelease = true), "0.2.0")
        assertEquals(UpdateResult.UpToDate, result)
    }

    @Test
    fun `ignores drafts`() {
        val result = UpdateChecker.evaluate(release("v0.3.0", draft = true), "0.2.0")
        assertEquals(UpdateResult.UpToDate, result)
    }

    @Test
    fun `refuses an APK URL on a non-GitHub host`() {
        val payload = release(
            "v0.3.0",
            apkUrl = "https://evil.example.com/plot2data-0.3.0.apk",
        )
        val result = UpdateChecker.evaluate(payload, "0.2.0")
        // The one asset's URL was refused, so no installable APK -> parse failure.
        assertTrue(result is UpdateResult.Failed)
    }

    @Test
    fun `refuses an APK URL for a different repo`() {
        val payload = release(
            "v0.3.0",
            apkUrl = "https://github.com/someone/else/releases/download/v0.3.0/plot2data-0.3.0.apk",
        )
        val result = UpdateChecker.evaluate(payload, "0.2.0")
        assertTrue(result is UpdateResult.Failed)
    }

    @Test
    fun `semver parse tolerates v prefix and rc suffix`() {
        assertEquals(Triple(1, 2, 3), UpdateChecker.parseSemver("v1.2.3"))
        assertEquals(Triple(1, 2, 3), UpdateChecker.parseSemver("1.2.3"))
        assertEquals(Triple(1, 2, 3), UpdateChecker.parseSemver("1.2.3-rc1"))
        assertEquals(Triple(1, 2, 3), UpdateChecker.parseSemver("1.2.3+build.5"))
        assertNull(UpdateChecker.parseSemver("1.2"))
        assertNull(UpdateChecker.parseSemver(""))
        assertNull(UpdateChecker.parseSemver("not a version"))
    }

    @Test
    fun `compare orders by major then minor then patch`() {
        assertTrue(UpdateChecker.compareTuple(Triple(1, 0, 0), Triple(0, 9, 9)) > 0)
        assertTrue(UpdateChecker.compareTuple(Triple(0, 2, 0), Triple(0, 1, 9)) > 0)
        assertTrue(UpdateChecker.compareTuple(Triple(0, 2, 1), Triple(0, 2, 0)) > 0)
        assertEquals(0, UpdateChecker.compareTuple(Triple(1, 2, 3), Triple(1, 2, 3)))
        assertTrue(UpdateChecker.compareTuple(Triple(0, 2, 0), Triple(0, 2, 1)) < 0)
    }

    @Test
    fun `missing tag_name is a parse failure`() {
        val payload = """{"body":"nope","assets":[]}"""
        val result = UpdateChecker.evaluate(payload, "0.2.0")
        assertTrue(result is UpdateResult.Failed)
    }

    @Test
    fun `malformed JSON is a parse failure`() {
        val result = UpdateChecker.evaluate("not JSON", "0.2.0")
        assertTrue(result is UpdateResult.Failed)
    }

    @Test
    fun `versionCode from release notes is read and preferred when available`() {
        val payload = release("v0.3.0", notes = "- speed up peaks\n\nplot2data: versionCode=3")
        val result = UpdateChecker.evaluate(payload, "0.2.0", currentVersionCode = 2)
        assertTrue(result is UpdateResult.Available)
        assertEquals(3, (result as UpdateResult.Available).info.versionCode)
    }

    @Test
    fun `versionCode downgrade is refused even when semver would offer it`() {
        // Someone attached a lower versionCode than ours; this never happens
        // from the release workflow, but the gate must still hold.
        val payload = release("v0.3.0", notes = "plot2data: versionCode=1")
        val result = UpdateChecker.evaluate(payload, "0.2.0", currentVersionCode = 2)
        assertEquals(UpdateResult.UpToDate, result)
    }

    @Test
    fun `versionCode absent falls back to semver`() {
        val payload = release("v0.3.0", notes = "plain notes with no machine line")
        val result = UpdateChecker.evaluate(payload, "0.2.0", currentVersionCode = 2)
        assertTrue(result is UpdateResult.Available)
        assertEquals(-1, (result as UpdateResult.Available).info.versionCode)
    }

    @Test
    fun `parseVersionCodeFromBody tolerates whitespace`() {
        assertEquals(5, UpdateChecker.parseVersionCodeFromBody("plot2data:  versionCode = 5"))
        assertEquals(2, UpdateChecker.parseVersionCodeFromBody("foo\nplot2data: versionCode=2\nbar"))
        assertEquals(-1, UpdateChecker.parseVersionCodeFromBody(""))
        assertEquals(-1, UpdateChecker.parseVersionCodeFromBody("plot2data: versionCode=abc"))
    }
}
