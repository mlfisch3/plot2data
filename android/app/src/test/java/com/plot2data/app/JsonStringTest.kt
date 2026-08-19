package com.plot2data.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Bridge payloads are spliced into a script handed to `evaluateJavascript`, so
 * an unescaped quote or line separator in a filename would be executable code.
 */
class JsonStringTest {

    @Test
    fun `quotes and backslashes are escaped`() {
        assertEquals(""""a\"b"""", Exports.jsonString("""a"b"""))
        assertEquals(""""a\\b"""", Exports.jsonString("""a\b"""))
    }

    @Test
    fun `a filename cannot break out of the string literal`() {
        val hostile = """");window.evil=1;//"""
        val encoded = Exports.jsonString(hostile)
        assertEquals(""""\");window.evil=1;//"""", encoded)
        // Every quote inside the literal is escaped, so none of it can close it.
        assertFalse(unescapedQuoteInside(encoded))
    }

    private fun unescapedQuoteInside(encoded: String): Boolean {
        var i = 1
        while (i < encoded.length - 1) {
            when (encoded[i]) {
                '\\' -> i += 2
                '"' -> return true
                else -> i += 1
            }
        }
        return false
    }

    @Test
    fun `control characters and js line separators are escaped`() {
        assertEquals(""""a\nb"""", Exports.jsonString("a\nb"))
        assertEquals(""""a\u0000b"""", Exports.jsonString("a\u0000b"))
        // Legal in JSON, but a statement terminator in a JavaScript source text.
        assertEquals(""""a\u2028b"""", Exports.jsonString("a\u2028b"))
        assertEquals(""""a\u2029b"""", Exports.jsonString("a\u2029b"))
    }
}
