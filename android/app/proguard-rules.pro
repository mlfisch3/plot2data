# The bridge is only ever called by name from JavaScript, so nothing in the
# bytecode references these methods and a shrinker would remove them.
-keepclassmembers class com.plot2data.app.MainActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
