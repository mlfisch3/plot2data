package com.plot2data.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The page picks the CSV filename from whatever the incoming image was called,
 * and a share target can put anything in that. These are the rules that keep
 * such a name from reaching the filesystem unchanged.
 */
class ExportsTest {

    @Test
    fun `keeps an ordinary name and adds the suffix`() {
        assertEquals("chart-data.csv", Exports.safeFileName("chart-data"))
        assertEquals("chart-data.csv", Exports.safeFileName("chart-data.csv"))
        assertEquals("Chart.CSV", Exports.safeFileName("Chart.CSV"))
    }

    @Test
    fun `strips directories so a name can never escape its folder`() {
        assertEquals("evil.csv", Exports.safeFileName("../../etc/evil"))
        assertEquals("evil.csv", Exports.safeFileName("/absolute/path/evil.csv"))
        assertEquals("evil.csv", Exports.safeFileName("""C:\Windows\evil.csv"""))
    }

    @Test
    fun `replaces characters a filesystem or share target would choke on`() {
        assertEquals("a-b-c-d.csv", Exports.safeFileName("""a:b*c?d"""))
        assertEquals("no-newline.csv", Exports.safeFileName("no\nnewline"))
        assertEquals("one two.csv", Exports.safeFileName("  one   two  "))
    }

    @Test
    fun `falls back when nothing usable is left`() {
        assertEquals(Exports.FALLBACK_NAME, Exports.safeFileName(null))
        assertEquals(Exports.FALLBACK_NAME, Exports.safeFileName(""))
        assertEquals(Exports.FALLBACK_NAME, Exports.safeFileName("   "))
        assertEquals(Exports.FALLBACK_NAME, Exports.safeFileName("..."))
    }

    @Test
    fun `caps the length but keeps it a csv`() {
        val name = Exports.safeFileName("x".repeat(400))
        assertTrue(name.length <= 120)
        assertTrue(name.endsWith(".csv"))
    }

    @Test
    fun `tokens are filenames, not paths`() {
        assertTrue(Exports.isValidToken("abc123DEF"))
        assertTrue(Exports.isValidToken("a-b_c"))
        assertFalse(Exports.isValidToken(""))
        assertFalse(Exports.isValidToken("../secret"))
        assertFalse(Exports.isValidToken("a/b"))
        assertFalse(Exports.isValidToken("a.bin"))
        assertFalse(Exports.isValidToken("x".repeat(65)))
    }

    @Test
    fun `keeps a workbook a workbook`() {
        assertEquals("chart-data.xlsx", Exports.safeFileName("chart-data", Exports.XLSX_EXTENSION))
        assertEquals("chart-data.xlsx", Exports.safeFileName("chart-data.xlsx", Exports.XLSX_EXTENSION))
        // A name the page derived from a CSV export keeps both parts rather than
        // pretending a `.csv` in the middle is the extension.
        assertEquals("chart.csv.xlsx", Exports.safeFileName("chart.csv", Exports.XLSX_EXTENSION))
        assertEquals("plot-data.xlsx", Exports.safeFileName("", Exports.XLSX_EXTENSION))
    }

    @Test
    fun `truncates to the cap with the longer extension too`() {
        val name = Exports.safeFileName("x".repeat(400), Exports.XLSX_EXTENSION)
        assertTrue(name.length <= 120)
        assertTrue(name.endsWith(".xlsx"))
    }
}
