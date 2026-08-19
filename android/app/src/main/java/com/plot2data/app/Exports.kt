package com.plot2data.app

/**
 * Naming and escaping helpers shared by the export paths.
 *
 * These are deliberately free of Android types so they can be exercised by the
 * JVM unit tests in `app/src/test/`, which is where the fiddly rules about
 * filenames arriving from a web page belong.
 */
object Exports {

    const val FALLBACK_NAME: String = "plot-data.csv"

    private const val MAX_NAME = 120
    private val ILLEGAL = Regex("""[\\/:*?"<>|\x00-\x1f]""")
    private val WHITESPACE = Regex("""\s+""")

    /**
     * Turn a filename suggested by the page into one that is safe to hand to the
     * Storage Access Framework or to write into the cache directory.
     *
     * The page derives the name from the loaded image, so it can contain
     * anything a share target ever put in a filename.
     */
    fun safeFileName(raw: String?): String {
        val stripped = (raw ?: "")
            .substringAfterLast('/')
            .substringAfterLast('\\')
            .replace(ILLEGAL, "-")
            .replace(WHITESPACE, " ")
            .trim()
            .trim('.')
        if (stripped.isEmpty()) return FALLBACK_NAME

        val withSuffix = if (stripped.endsWith(".csv", ignoreCase = true)) stripped else "$stripped.csv"
        if (withSuffix.length <= MAX_NAME) return withSuffix
        val head = withSuffix.take(MAX_NAME - 4).trim().trim('.')
        return if (head.isEmpty()) FALLBACK_NAME else "$head.csv"
    }

    /** A token is only ever used as a cache filename, so it must not be a path. */
    fun isValidToken(token: String): Boolean =
        token.isNotEmpty() &&
            token.length <= 64 &&
            token.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' }

    /**
     * Minimal JSON string literal.
     *
     * U+2028 and U+2029 are escaped as well as the usual suspects: they are legal
     * in JSON but terminate a line in a JavaScript source text, and this string
     * is spliced into a script passed to `evaluateJavascript`.
     */
    fun jsonString(value: String): String {
        val out = StringBuilder(value.length + 2)
        out.append('"')
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' || c == '\u2028' || c == '\u2029' -> out.append("\\u%04x".format(c.code))
                else -> out.append(c)
            }
        }
        out.append('"')
        return out.toString()
    }
}
