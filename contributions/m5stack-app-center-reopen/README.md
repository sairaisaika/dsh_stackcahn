# Reopen a verified App Center installation

This patch targets the published StackChan v1.6.2 source at `28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400`. It adds an optional **Open** action for catalog entries whose exact image remains in the inactive application slot. The user can launch the installed image from its App Center details without downloading or rewriting the image.

The feature is off by default. On a clean checkout, apply `reopen.patch`, prepare the upstream dependencies and pass `sdkconfig.reopen.defaults` after the project's original `sdkconfig.defaults` when configuring ESP-IDF v6.1. The option requires application rollback and is unavailable with the SDK's anti-rollback option, which can erase an image during boot selection.

## Catalog contract

On the HTTPS App Center catalog response, the publisher may add `reopenImageSha256` to an entry for an app designed to return to the previously confirmed firmware. The value is the 64 lowercase hex characters from the ESP application's validation hash. ESP-IDF reports that value through `esp_partition_get_sha256`. Keep the field synchronized with the image that `firmwareUrl` serves.

The menu offers **Open** when the running firmware is also the selected and confirmed firmware, the application layout has exactly two OTA slots, and the other slot contains an ABORTED image with the matching verified digest. The action rechecks these conditions outside the display lock. It uses the SDK's normal boot-selection API and restarts only after the API accepts the target. A stale selection returns to details. A new download still requires the user's click. A firmware update already selected for boot takes precedence.

The app and Setup firmware-update callbacks run synchronously on the existing application task. The selection must remain serialized with OTA writers if that scheduling is changed.

## Review scope

The target build compiles the App Center UI and HAL changes. A separate ESP-IDF v6.1 QEMU probe calls the same selection helper on Flash copies, with the original bootloader and both application slots represented. Two complete reopen and rollback cycles preserved the application bytes. Guard cases covered missing or wrong digests, corrupted image bytes, a missing OTA record, pending factory confirmation and a target already selected by an update.

This review targets the repeat-launch entry inside App Center. Catalog provisioning still belongs to M5Stack. The optional [Home receiver patch](../m5stack-app-center-home/README.md) opens the launcher for a single boot after an explicit Home request. A supported production build must be checked with the real catalog, touch UI, factory voice and StackChan World binding. The companion DSH image also needs the exact production factory image hash for its return check. The patch changes the public application sources only.
