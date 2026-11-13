import java.io.File
import java.util.Properties
import org.gradle.api.tasks.Sync

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val testSecrets = Properties().apply {
    val secretsFile = rootProject.file("test-secrets.properties")
    if (secretsFile.isFile) secretsFile.inputStream().use(::load)
}
val playBuild = providers.gradleProperty("playBuild").orNull?.toBoolean() == true ||
    providers.gradleProperty("playFeasibility").orNull?.toBoolean() == true
val privacyPolicyUrl = providers.gradleProperty("privacyPolicyUrl").orNull
    ?: "https://github.com/ixboss/universal-harness/blob/main/android/PRIVACY.md"
// Release signing (v1.0.0): cross-platform env vars. The legacy MH_* names are
// honoured as a fallback for existing CI setups.
val uploadStorePath = providers.environmentVariable("UH_KEYSTORE_PATH").orNull
    ?: providers.environmentVariable("MH_UPLOAD_STORE_FILE").orNull
val uploadStorePassword = providers.environmentVariable("UH_KEYSTORE_PASSWORD").orNull
    ?: providers.environmentVariable("MH_UPLOAD_STORE_PASSWORD").orNull
val uploadKeyAlias = providers.environmentVariable("UH_KEY_ALIAS").orNull
    ?: providers.environmentVariable("MH_UPLOAD_KEY_ALIAS").orNull
val uploadKeyPassword = providers.environmentVariable("UH_KEY_PASSWORD").orNull
    ?: providers.environmentVariable("MH_UPLOAD_KEY_PASSWORD").orNull

// Automatic fallback keystore so Windows local builds and Linux CI runners
// produce *installable* release APKs with zero setup. The fallback is generated
// on demand with keytool from the JDK running Gradle (no binary committed).
val fallbackKeystore = rootProject.file("keystore/fallback-release.jks")
if (!fallbackKeystore.isFile) {
    val isWindows = System.getProperty("os.name").lowercase().contains("windows")
    val keytool = File(System.getProperty("java.home"), if (isWindows) "bin/keytool.exe" else "bin/keytool")
    if (keytool.isFile) {
        fallbackKeystore.parentFile.mkdirs()
        val proc = ProcessBuilder(
            keytool.absolutePath, "-genkeypair", "-v",
            "-keystore", fallbackKeystore.absolutePath,
            "-alias", "universal-harness",
            "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950",
            "-storepass", "universal-harness", "-keypass", "universal-harness",
            "-dname", "CN=Universal Harness Fallback Release, O=universal-harness, C=US",
        ).redirectErrorStream(true).start()
        val out = proc.inputStream.bufferedReader().readText()
        check(proc.waitFor() == 0) { "could not generate the fallback release keystore:\n$out" }
    }
}
val hasUploadSigning = listOf(
    uploadStorePath,
    uploadStorePassword,
    uploadKeyAlias,
    uploadKeyPassword,
).all { !it.isNullOrBlank() }
val runtimeReleaseBaseUrl =
    "https://github.com/ixboss/universal-harness/releases/download/runtime-v1.0.0"
val appUpdateManifestUrl =
    "https://github.com/ixboss/universal-harness/releases/latest/download/universal-harness-update.json"
val runtimeBundleDir = rootProject.layout.projectDirectory.dir("dist/runtime-bundles")
val generatedRuntimeAssets = layout.buildDirectory.dir("generated/runtime-assets")

// Universal Harness Phase 3B: stage the JS node into the APK. The node has zero
// runtime dependencies (pure ESM), so the guest runs exactly the same source as
// desktop — no second implementation, no transpiled copy. The repository tree is
// the single source of truth; this Sync task is what keeps them identical.
// The repository root is the Android project's parent directory; the JS node staged
// into the APK comes from exactly that tree (bin/, core/, manifests/, shared/).
val repoRoot = rootProject.layout.projectDirectory.dir("..")
val generatedUhJsAssets = layout.buildDirectory.dir("generated/uh-js-assets")
val prepareUhJsAssets = tasks.register<Sync>("prepareUhJsAssets") {
    from(repoRoot) {
        include("bin/**")
        include("core/**")
        include("manifests/**")
        include("shared/**")
        include("package.json")
        exclude("**/node_modules/**")
        exclude("**/.git/**")
    }
    into(generatedUhJsAssets.map { it.dir("uh-js") })
}

// Universal Harness adaptation (Phase 3A): the upstream Mobile-Harness release bundles are
// not part of this repository (they live in upstream's GitHub releases only), so these Sync
// tasks skip instead of failing when the bundle files are absent. Universal Harness builds
// its own runtime on-device (com.universalharness.node.UhRuntimeInstaller).
val prepareBundledAgentAssets = tasks.register<Sync>("prepareBundledAgentAssets") {
    val src = runtimeBundleDir.file("pocketdev-agy-arm64-2026.09.1.tar.zst")
    from(src)
    into(generatedRuntimeAssets.map { it.dir("shared/runtime") })
    onlyIf { src.asFile.isFile }
}

val prepareOfflineRuntimeAssets = tasks.register<Sync>("prepareOfflineRuntimeAssets") {
    val sources = listOf(
        "pocketdev-core-arm64-2026.09.5.tar.zst",
        "pocketdev-claude-arm64-2026.09.1.tar.zst",
        "pocketdev-python-arm64-2026.09.2.tar.zst",
        "pocketdev-android-arm64-2026.09.1.tar.zst",
        "pocketdev-dsh-arm64-2026.09.1.tar.zst",
    ).map { runtimeBundleDir.file(it) }
    from(sources)
    into(generatedRuntimeAssets.map { it.dir("offline/runtime") })
    onlyIf { sources.any { it.asFile.isFile } }
}

fun buildConfigString(value: String): String =
    "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

android {
    namespace = "com.jarves.mh"
    compileSdk = 36
    // F-Droid's r26b recipe installs 26.1.10909125. Keep AGP from selecting
    // its newer default NDK; local developers may override this explicitly.
    ndkVersion = providers.gradleProperty("mhNdkVersion").orNull ?: "26.1.10909125"

    signingConfigs {
        create("upload") {
            if (hasUploadSigning) {
                storeFile = if (File(checkNotNull(uploadStorePath)).isAbsolute) {
                    File(checkNotNull(uploadStorePath))
                } else {
                    rootProject.file(checkNotNull(uploadStorePath))
                }
                storePassword = checkNotNull(uploadStorePassword)
                keyAlias = checkNotNull(uploadKeyAlias)
                keyPassword = checkNotNull(uploadKeyPassword)
            } else if (fallbackKeystore.isFile) {
                // Zero-setup fallback: installable, but not for Play upload. The
                // literal credentials below are public by design (generated
                // on-demand keystore) — uh-secret-fixture.
                storeFile = fallbackKeystore
                storePassword = "universal-harness" // uh-secret-fixture (public by design)
                keyAlias = "universal-harness"
                keyPassword = "universal-harness" // uh-secret-fixture (public by design)
            }
        }
    }

    defaultConfig {
        applicationId = "com.jarves.mh"
        minSdk = 28
        // The direct APK retains the proven target-28 PRoot execution path. The
        // Play build targets current Android while its runtime path is validated.
        targetSdk = if (playBuild) 36 else 28
        // Keep literal defaults so F-Droid's static manifest parser can detect
        // the tagged release. Gradle properties may still override Play builds.
        versionCode = 6
        versionName = "1.0.0"
        providers.gradleProperty("appVersionCode").orNull?.toIntOrNull()?.let { versionCode = it }
        providers.gradleProperty("appVersionName").orNull?.let { versionName = it }

        ndk.abiFilters += "arm64-v8a"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables.useSupportLibrary = true

        buildConfigField("boolean", "IS_PLAY_BUILD", playBuild.toString())
        buildConfigField("String", "PRIVACY_POLICY_URL", buildConfigString(privacyPolicyUrl))

        buildConfigField(
            "String",
            "TEST_OPENROUTER_API_KEY",
            "\"\"",
        )
    }

    flavorDimensions += "runtimeDelivery"
    productFlavors {
        create("online") {
            dimension = "runtimeDelivery"
            buildConfigField("boolean", "OFFLINE_RUNTIME_BUNDLES", "false")
            buildConfigField("String", "RUNTIME_RELEASE_BASE_URL", buildConfigString(runtimeReleaseBaseUrl))
            buildConfigField("String", "APP_UPDATE_MANIFEST_URL", buildConfigString(appUpdateManifestUrl))
            buildConfigField("String", "APP_VARIANT", "\"online\"")
        }
        create("offline") {
            dimension = "runtimeDelivery"
            buildConfigField("boolean", "OFFLINE_RUNTIME_BUNDLES", "true")
            buildConfigField("String", "RUNTIME_RELEASE_BASE_URL", buildConfigString(runtimeReleaseBaseUrl))
            buildConfigField("String", "APP_UPDATE_MANIFEST_URL", buildConfigString(appUpdateManifestUrl))
            buildConfigField("String", "APP_VARIANT", "\"offline\"")
        }
    }

    sourceSets.getByName("offline").assets.srcDir(generatedRuntimeAssets.map { it.dir("offline") })
    sourceSets.getByName("main").assets.srcDir(generatedRuntimeAssets.map { it.dir("shared") })
    // The staged JS node ships in every flavor's assets (it is the node itself).
    sourceSets.getByName("main").assets.srcDir(generatedUhJsAssets)

    buildTypes {
        debug {
            buildConfigField(
                "String",
                "TEST_OPENROUTER_API_KEY",
                buildConfigString(testSecrets.getProperty("openrouter.apiKey", "")),
            )
        }
        release {
            isMinifyEnabled = false
            // Env-signed when credentials are present; otherwise the generated
            // fallback keystore still produces an installable APK.
            signingConfig = signingConfigs.getByName("upload")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions.jvmTarget = "17"
    buildFeatures {
        compose = true
        buildConfig = true
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    packaging.jniLibs.useLegacyPackaging = true
    androidResources.noCompress += "zst"
}

tasks.matching { it.name.startsWith("mergeOffline") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(prepareOfflineRuntimeAssets) }

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }
    .configureEach { dependsOn(prepareBundledAgentAssets, prepareUhJsAssets) }

tasks.matching { it.name.contains("lint", ignoreCase = true) }
    .configureEach { dependsOn(prepareBundledAgentAssets, prepareUhJsAssets) }

tasks.matching { it.name.contains("Offline") && it.name.contains("lint", ignoreCase = true) }
    .configureEach { dependsOn(prepareOfflineRuntimeAssets) }

tasks.register("playReadinessCheck") {
    group = "verification"
    description = "Checks configuration required before uploading a Mobile Harness Play bundle."
    doLast {
        check(playBuild) { "Run with -PplayBuild=true." }
        check(privacyPolicyUrl.startsWith("https://")) {
            "privacyPolicyUrl must be a public HTTPS URL."
        }
        check(hasUploadSigning) {
            "Set UH_KEYSTORE_PATH, UH_KEYSTORE_PASSWORD, UH_KEY_ALIAS, and UH_KEY_PASSWORD."
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2025.02.00"))
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-compose:1.10.0")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.apache.commons:commons-compress:1.27.1")
    implementation("com.github.luben:zstd-jni:1.5.6-9@aar")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
    testImplementation(kotlin("test")) // com.universalharness.node unit tests
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
