package com.universalharness.node

/**
 * Cryptographically pinned acquisition sources for the Universal Harness Android runtime.
 *
 * Every hash below was read from the official checksum source named beside it and is
 * re-verified after download before anything is extracted or executed. A pin without a hash
 * is not a pin (same rule as manifests/runtime.manifest.json).
 */
object UhPins {
    /** Pinned upstream dsh version (mirrors manifests/runtime.manifest.json in the repo root). */
    const val NODE_VERSION = "v24.21.0"
    const val DSH_PACKAGE = "@deepseek-ai/dsh"
    const val DSH_VERSION = "0.2.0-rc.2"

    /**
     * Ubuntu 20.04.5 LTS arm64 base rootfs. SHA-256 from
     * https://cdimage.ubuntu.com/ubuntu-base/releases/20.04/release/SHA256SUMS
     * (verified live on 2026-10-01; also pinned by Mobile-Harness's runtime-bundle script).
     */
    const val UBUNTU_BASE_URL =
        "https://cdimage.ubuntu.com/ubuntu-base/releases/20.04/release/ubuntu-base-20.04.5-base-arm64.tar.gz"
    const val UBUNTU_BASE_SHA256 = "f9b999afb4c4b10193087ea8c11be36d688f19e609b05179b571f29357954b52"

    /**
     * Official Node.js linux-arm64 distribution (glibc; requires glibc >= 2.28, satisfied by
     * Ubuntu 20.04). SHA-256 from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt. The .tar.gz
     * flavor is used so extraction needs only gzip support (commons-compress), not xz.
     */
    const val NODE_URL = "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.gz"
    const val NODE_SHA256 = "724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"
    const val NODE_ARCHIVE_ROOT = "node-v24.21.0-linux-arm64"

    /** npm tarball + integrity for the pinned dsh release (mirrors the repo manifest). */
    const val DSH_TARBALL_URL =
        "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.0-rc.2.tgz"
    const val DSH_TARBALL_SHA512 =
        "sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA=="

    /** Exact version string `dsh --version` must report inside the guest. */
    const val EXPECTED_DSH_VERSION_OUTPUT = DSH_VERSION
}
