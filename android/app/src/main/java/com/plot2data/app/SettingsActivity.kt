package com.plot2data.app

import android.app.AlertDialog
import android.os.Bundle
import android.text.format.DateUtils
import android.widget.Button
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.text.DateFormat
import java.util.Date

/**
 * The native settings screen for the auto-update feature. Reachable through
 * the WebView bridge (the page shows a cog on the Android build), and from
 * nowhere else - a normal browser never sees any of this.
 */
class SettingsActivity : ComponentActivity() {

    private lateinit var manager: UpdateManager
    private lateinit var toggle: Switch
    private lateinit var currentVersion: TextView
    private lateinit var lastChecked: TextView
    private lateinit var lastResult: TextView
    private lateinit var checkNow: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContentView(R.layout.activity_settings)

        val root = findViewById<android.view.View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, windowInsets ->
            val bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            windowInsets
        }

        manager = UpdateManager(this)
        toggle = findViewById(R.id.toggle_auto_check)
        currentVersion = findViewById(R.id.current_version)
        lastChecked = findViewById(R.id.last_checked)
        lastResult = findViewById(R.id.last_result)
        checkNow = findViewById(R.id.check_now)

        toggle.isChecked = manager.isAutoCheckEnabled
        toggle.setOnCheckedChangeListener { _, isChecked ->
            manager.setAutoCheckEnabled(isChecked)
        }

        checkNow.setOnClickListener { runManualCheck() }

        renderState()
    }

    override fun onResume() {
        super.onResume()
        renderState()
    }

    override fun onDestroy() {
        manager.dispose()
        super.onDestroy()
    }

    private fun renderState() {
        currentVersion.text = getString(R.string.settings_current_version, BuildConfig.VERSION_NAME)
        val last = manager.lastCheckedAt
        lastChecked.text = if (last <= 0L) {
            getString(R.string.settings_last_checked_never)
        } else {
            val when_ = DateUtils.getRelativeDateTimeString(
                this,
                last,
                DateUtils.MINUTE_IN_MILLIS,
                DateUtils.WEEK_IN_MILLIS,
                0,
            )?.toString() ?: DateFormat.getDateTimeInstance().format(Date(last))
            getString(R.string.settings_last_checked_at, when_)
        }
        lastResult.text = manager.lastResult
    }

    private fun runManualCheck() {
        checkNow.isEnabled = false
        manager.checkInBackground { result ->
            checkNow.isEnabled = true
            renderState()
            when (result) {
                is UpdateResult.Available -> showUpdateDialog(result.info)
                UpdateResult.UpToDate -> toast(R.string.update_up_to_date_toast)
                is UpdateResult.Failed -> toast(R.string.update_check_failed_toast)
            }
        }
    }

    private fun showUpdateDialog(info: UpdateInfo) {
        val installed = BuildConfig.VERSION_NAME
        val builder = AlertDialog.Builder(this)
            .setTitle(getString(R.string.update_available_title, info.versionName))
            .setPositiveButton(R.string.update_install_now) { _, _ ->
                manager.downloadAndInstall(info) {}
            }
            .setNegativeButton(R.string.update_install_later, null)

        val notesExcerpt = info.notes.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .take(10)
            .joinToString("\n")
        val message = buildString {
            append(getString(R.string.update_available_message, installed, info.versionName))
            if (notesExcerpt.isNotEmpty()) {
                append("\n\n")
                append(notesExcerpt)
            }
        }
        builder.setMessage(message).show()
    }

    private fun toast(resId: Int) {
        Toast.makeText(this, resId, Toast.LENGTH_SHORT).show()
    }
}
