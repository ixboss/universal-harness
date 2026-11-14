plugins {
    id("com.android.application") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.21" apply false
    // Audit 2.5: CycloneDX SBOM generation for the Android build (build-time
    // only; generates build/reports at `gradlew cyclonedxBom`). UNVERIFIED on
    // the audit host (no JDK); CI's android jobs validate it.
    id("org.cyclonedx.bom") version "3.6.1" apply false
}
