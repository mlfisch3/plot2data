plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.plot2data.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.plot2data.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"

        // Repo coordinates for the auto-update checker. Hard-coded here so
        // UpdateHttp's allow list can be a compile-time constant.
        buildConfigField("String", "P2D_REPO_OWNER", "\"mlfisch3\"")
        buildConfigField("String", "P2D_REPO_NAME", "\"plot2data\"")
        buildConfigField("String", "P2D_REPO", "\"mlfisch3/plot2data\"")
    }

    buildFeatures {
        buildConfig = true
    }

    // Release signing: a stable keystore held in GitHub Actions secrets so each
    // tagged APK is signed with the same identity and installs cleanly on top
    // of the previous one. Set `P2D_RELEASE_KEYSTORE` (an absolute path) and
    // the three password/alias env vars; if any is missing we fall back to
    // debug signing so a local `assembleRelease` still produces an APK for
    // smoke-testing. See RELEASING.md.
    val releaseKeystorePath: String? = System.getenv("P2D_RELEASE_KEYSTORE")
    val releaseStorePassword: String? = System.getenv("P2D_RELEASE_KEYSTORE_PASSWORD")
    val releaseKeyAlias: String? = System.getenv("P2D_RELEASE_KEY_ALIAS")
    val releaseKeyPassword: String? = System.getenv("P2D_RELEASE_KEY_PASSWORD")
    val haveReleaseSigning = !releaseKeystorePath.isNullOrBlank() &&
        !releaseStorePassword.isNullOrBlank() &&
        !releaseKeyAlias.isNullOrBlank() &&
        !releaseKeyPassword.isNullOrBlank() &&
        file(releaseKeystorePath).exists()

    signingConfigs {
        if (haveReleaseSigning) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = if (haveReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
        disable += setOf(
            // Deliberate: targetSdk 35 is the newest this AGP supports properly,
            // and the app has no behaviour that a newer target would change.
            "OldTargetApi",
            // Deliberate: the dependency versions are pinned to ones that build
            // against compileSdk 35. This check only says newer ones exist.
            "GradleDependency",
            // Wrong here: it wants mipmap-anydpi-v26 merged into mipmap-anydpi
            // because minSdk is already 26, but aapt does not find the adaptive
            // icon there and the build fails outright. See the note in
            // res/mipmap-anydpi-v26/ic_launcher.xml.
            "ObsoleteSdkInt",
        )
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module")
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")
    // The auto-update checker talks to api.github.com and downloads the signed
    // APK. OkHttp is standard, small, and lets us pin the hostname set at the
    // request-interceptor level - checked by UpdateHttpTest.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.0.21")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    // org.json is bundled in android.jar as a stub for unit tests; the real
    // library is needed on the JVM test classpath for UpdateChecker's parser.
    testImplementation("org.json:json:20240303")
}
