package com.plot2data.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The update checker only ever talks to GitHub. These tests are the written
 * form of that rule: a one-liner change to [UpdateHttp.isGitHubHost] widens
 * the attack surface, so each listed host is here on purpose and each refused
 * one is here because something plausible-looking has to be refused.
 */
class UpdateHttpTest {

    @Test
    fun `accepts the two GitHub API and web hosts`() {
        assertTrue(UpdateHttp.isGitHubHost("api.github.com"))
        assertTrue(UpdateHttp.isGitHubHost("github.com"))
    }

    @Test
    fun `accepts the GitHub asset CDN subdomains`() {
        assertTrue(UpdateHttp.isGitHubHost("objects.githubusercontent.com"))
        assertTrue(UpdateHttp.isGitHubHost("release-assets.githubusercontent.com"))
        assertTrue(UpdateHttp.isGitHubHost("codeload.githubusercontent.com"))
        assertTrue(UpdateHttp.isGitHubHost("githubusercontent.com"))
    }

    @Test
    fun `refuses anything else`() {
        assertFalse(UpdateHttp.isGitHubHost(null))
        assertFalse(UpdateHttp.isGitHubHost(""))
        assertFalse(UpdateHttp.isGitHubHost("example.com"))
        assertFalse(UpdateHttp.isGitHubHost("evil.com"))
        assertFalse(UpdateHttp.isGitHubHost("api-github.com"))
        assertFalse(UpdateHttp.isGitHubHost("github.com.evil.com"))
        assertFalse(UpdateHttp.isGitHubHost("githubusercontent.com.evil.com"))
        assertFalse(UpdateHttp.isGitHubHost("notgithubusercontent.com"))
        assertFalse(UpdateHttp.isGitHubHost("raw.githubusercontent.com.evil.com"))
    }

    @Test
    fun `isAllowedUrl requires https on an allowed host`() {
        assertTrue(UpdateHttp.isAllowedUrl("https://api.github.com/foo"))
        assertTrue(UpdateHttp.isAllowedUrl("https://github.com/owner/repo/releases"))
        assertTrue(UpdateHttp.isAllowedUrl("https://objects.githubusercontent.com/abc"))
        // Plain http is refused even on a right host; the APIs serve TLS only.
        assertFalse(UpdateHttp.isAllowedUrl("http://api.github.com/foo"))
        assertFalse(UpdateHttp.isAllowedUrl("https://example.com/foo"))
        assertFalse(UpdateHttp.isAllowedUrl("ftp://github.com/foo"))
        assertFalse(UpdateHttp.isAllowedUrl(null))
        assertFalse(UpdateHttp.isAllowedUrl("not a url"))
    }

    @Test
    fun `isReleaseAssetUrl accepts the canonical download URL`() {
        val url = "https://github.com/mlfisch3/plot2data/releases/download/v0.2.0/plot2data-0.2.0.apk"
        assertTrue(UpdateHttp.isReleaseAssetUrl(url))
    }

    @Test
    fun `isReleaseAssetUrl accepts the CDN URL (follow a GitHub redirect to it)`() {
        val url = "https://objects.githubusercontent.com/github-production-release-asset/abc/def"
        assertTrue(UpdateHttp.isReleaseAssetUrl(url))
    }

    @Test
    fun `isReleaseAssetUrl rejects other repos even on github dot com`() {
        val url = "https://github.com/other/project/releases/download/v1/evil.apk"
        assertFalse(UpdateHttp.isReleaseAssetUrl(url))
    }

    @Test
    fun `isReleaseAssetUrl rejects non-releases paths on github dot com`() {
        val url = "https://github.com/mlfisch3/plot2data/raw/main/some-file.apk"
        assertFalse(UpdateHttp.isReleaseAssetUrl(url))
    }

    @Test
    fun `isReleaseAssetUrl rejects http and other hosts`() {
        assertFalse(UpdateHttp.isReleaseAssetUrl(null))
        assertFalse(UpdateHttp.isReleaseAssetUrl("http://github.com/mlfisch3/plot2data/releases/download/v1/x.apk"))
        assertFalse(UpdateHttp.isReleaseAssetUrl("https://evil.com/mlfisch3/plot2data/releases/download/v1/x.apk"))
    }

    @Test
    fun `the latest-release URL points at this repo on the API host`() {
        assertEquals(
            "https://api.github.com/repos/mlfisch3/plot2data/releases/latest",
            UpdateHttp.LATEST_RELEASE_URL,
        )
    }
}
