# Return to the launcher from an App Center application

This application-only patch targets the public StackChan v1.6.2 commit `28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400`. It can be applied together with the [installed-app reopen patch](../m5stack-app-center-reopen/README.md). The receiver is off by default. To build the experiment on ESP-IDF v6.1, apply `home.patch` and include `sdkconfig.home.defaults` after the upstream defaults.

Both applications reserve the first 32 bytes of ESP32-S3 RTC slow memory and leave that region free of ULP code. After draining the running session and verifying the confirmed fallback, the DSH Home callback arms a ticket containing the target partition address, its complement and the versioned commit words. It then calls `esp_restart()`. The bootloader performs its normal rollback. The factory application clears the ticket as soon as it reads it. It uses the ticket only after a software reset into the named confirmed slot with the other slot marked ABORTED.

A valid ticket makes the launcher run for that boot. Normal startup still reads the user's AI Agent preference. The handoff neither reads nor writes that preference or other NVS data. It leaves the bootloader and partition table unchanged. A pre-existing launcher setup request keeps its normal handling within the original launcher.

For the paired DSH build, run `scripts/prepare_agent.py` with both `--app-center-baseline` and `--app-center-home-stock`, pointing the latter to the receiver's `stack-chan.bin`. Run `scripts/build_agent.py` for the prepared checkout. The DSH application verifies the exact receiver image before startup and again after Home drains its resources. Its ordinary App Center build still targets the original factory digest.

The public patch does not provide M5Stack production authentication. An official production receiver and the exact matching companion image are required before a hardware release can be reviewed. Validate the launcher, repeated entry, factory voice and the existing StackChan World binding on the same device. The offline probe and its readback checks are documented in the [project Wiki](../../wiki/app-center.md#一次性-home-返回原厂菜单).
