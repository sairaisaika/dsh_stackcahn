# StackChan App Center launcher integration review

This review adds an opt-in **DSH.AGENT** entry to the StackChan launcher. The user installs or opens the matching App Center listing once, then launches the verified local copy from the main menu. Home releases the active session resources and returns through the original bootloader to the same menu. The normal startup preference still applies on ordinary boots. The patch series targets public v1.6.2 and keeps the original partition table and bootloader. [Official manual](https://docs.m5stack.com/en/StackChan/#app-center)

## Decisions for the production team

| Surface | Decision and acceptance evidence |
| --- | --- |
| Factory firmware | Carry the opt-in launcher, the Home receiver and the App Center Open handler in a production build for K151, or provide an equivalent supported extension interface. Use the existing production build pipeline for M5Stack service authentication. Check that the free voice assistant answers and that StackChan World still connects to the same account-bound device. [Authentication discussion](https://github.com/m5stack/StackChan/issues/134) |
| App Center | Allocate a test catalogue ID and publish the exact companion app via HTTPS. Return the numeric ID and the companion's ESP image validation SHA-256 in the optional `reopenImageSha256` field. The reviewer value `31337` is for local builds. Confirm the release URL and digest against the actual offered image. [App Center administration](https://github.com/m5stack/StackChan/blob/main/server/README.MD#63-add-an-app-store-item) |
| Image pairing and storage | Provide the exact receiver application image identity for the companion build, and confirm the existing two-slot lifecycle and independent settings allocation. The DSH build uses that receiver digest for its return guard. Review whether a following factory update can replace the DSH slot and require a companion rebuild. [OTA state model](https://docs.espressif.com/projects/esp-idf/en/v6.1/esp32s3/api-reference/system/ota.html) |

## Reproduce the public build and host checks

Use Python 3.10+, Git, and Clang. For the target build use the ESP32-S3 toolchain and the ESP-IDF commit in `firmware/upstream.lock.json`. The source preparation script retrieves the documented public upstream checkout and pinned dependencies.

Run the following from the root of the extracted archive. Give the checkout a fresh path.

```sh
review_dir="$(pwd)"
python3 scripts/prepare_firmware.py --destination "$review_dir/stackchan-review"
for patch in home reopen shortcut; do
    git -C "$review_dir/stackchan-review" apply --check "$review_dir/patches/$patch.patch" || exit
    git -C "$review_dir/stackchan-review" apply "$review_dir/patches/$patch.patch" || exit
done
python3 tests/run.py --stock "$review_dir/stackchan-review"
```

With the pinned ESP-IDF environment active, build the enabled review variant. The receiver configuration ID is scoped to local review. For a default-off build, use a different build and SDK config path and only `sdkconfig.defaults`.

```sh
idf.py -C "$review_dir/stackchan-review/firmware" \
    -B "$review_dir/stackchan-review/firmware/build-review" \
    -DSDKCONFIG="$review_dir/stackchan-review/firmware/build-review/sdkconfig" \
    "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;$review_dir/defaults/sdkconfig.home.defaults;$review_dir/defaults/sdkconfig.reopen.defaults;$review_dir/defaults/sdkconfig.shortcut.defaults" \
    build
```

`source-review.json` identifies the exact public builds used for the offline evidence and lists each exported source file's SHA-256. Its `BuildSha256` fields hash whole files. Its `ImageValidationSha256` fields record the digest checked by ESP-IDF and illustrate the App Center and Home identity format. Generate those values again from the final production pair. This archive contains source, a host fixture and the ESP32-S3 probe source. The recorded QEMU runs used the original bootloader on virtual Flash copies, with synthetic settings. Replaying those runs requires the development project's audit harness and a reviewed compatible Flash fixture. The manifest records the covered behavior and the scope of each run.

When present, `sdkWriter.matrix` lists the measured full-candidate erase range for each confirmed factory slot and the number of write and boot scenarios. The writer test covers interrupted downloads, rejected images, retry, and restoration using the same companion bytes identified in the manifest. Verify the scope again with the actual production pair and catalogue.

## Production acceptance

1. Capture the current factory recovery baseline. Confirm the official assistant answers and StackChan World still sees the bound device.
2. Use the official production delivery procedure, recheck the same voice and binding, and capture an App Center pre-install baseline. Confirm the exact receiver identity and the rollback state before installing DSH.
3. Install or open the exact listing, enter the existing DSH session, and exercise Stop followed by the normal swipe and Home gesture. Open the icon offline, repeat Home, and verify the display switch in Setup.
4. Review the factory settings by value and the OTA writes by sector. Verify an interrupted install, an in-progress factory update, and restoration of the previous slot contents through the approved recovery procedure. Retest the same original voice and phone binding after return.

The public review uses development images. Installation approval depends on the supported production package, the device's current state and same-device acceptance.
