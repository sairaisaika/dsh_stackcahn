# StackChan launcher integration review

This proposal adds a touch entry that opens an independent DSH application and returns to the same StackChan launcher with the standard Home gesture. The production integration would keep AI Agent and StackChan World in M5Stack's application and use the normal factory OTA confirmation path.

## Source review

The application patch applies to public StackChan v1.6.2 at commit `28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400`. It adds the optional `CONFIG_STACKCHAN_DSH_MENU` build setting, which defaults to off. With the setting enabled, Setup → Apps → App visibility includes a DSH.AGENT row, visible by default. The row uses the registered Mooncake app ID and saves only `feature_toggles/dsh_visible`. The existing six-bit `visible_mask` remains readable by factory builds, and Setup is always accessible to restore a hidden icon. The launcher refreshes when the user returns from Setup. [StackChan v1.6.2](https://github.com/m5stack/StackChan/tree/28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400)

`sdkconfig.menu.defaults` enables the entry in the review build. The application and reference selector share an eight-byte, versioned RTC reservation. On a menu tap, the public launcher checks the selector identity, the dedicated app slot and the confirmed manufacturer OTA state. On Home, the reference selector starts the confirmed manufacturer app and sends a one-time request to show the launcher. Normal startup still uses the user's saved AI Agent preference. [StackChan navigation](https://docs.m5stack.com/en/StackChan/#ui-navigation) · [ESP-IDF OTA rollback](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/system/ota.html#app-rollback)

The exported `selector/` directory is the public ESP-IDF v5.5.4 reference implementation. The version of ESP-IDF is pinned there. Its geometry check assumes both standard manufacturer OTA app slots remain available and the independent application occupies an app/test partition outside their rotation. The prototype also uses a separate NVS partition for its own settings. The reference selector uses normal ESP-IDF image verification. The applicable installation, signer and update policies are decisions for the factory firmware team. [ESP-IDF partition tables](https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/api-guides/partition-tables.html)

## Request for M5Stack maintainers

Would M5Stack consider carrying a small launcher and Home integration in a K151 production test build, or point us to a supported extension interface that provides equivalent behavior? The integration needs a persistent entry across factory updates, an independent application and settings area, and a one-time return to the main menu. Production authentication and release signing can stay in the existing factory build pipeline. [Related authentication discussion](https://github.com/m5stack/StackChan/issues/134)

| Interface | Decision requested from M5Stack | Hardware acceptance |
| --- | --- | --- |
| Entry and Home | Can a production K151 build carry the opt-in launcher and one-time return hook, or expose an equivalent extension interface? | Hide and restore the icon in Setup. Open DSH by touch twice, with a Home return in between. After Home, show the menu even when automatic AI Agent startup is enabled. A subsequent normal boot uses the saved preference. |
| Independent app and settings | Which partition and settings space can be assigned, and what image validation or signing applies to a third-party release? | Use the current DSH transport and controls. Confirm that pairing survives a return to the factory app and a second launch. Confirm that the original assistant answers and StackChan World still connects to the existing binding. |
| Factory updates and recovery | Which supported update path retains compatibility, and how should an interrupted install or an incompatible application be recovered? | Finish a normal factory OTA, open DSH again, then return to the factory assistant. Verify recovery after an interrupted update without losing the existing binding. |

An App Center test listing is another way to evaluate an independent app on the current production launcher. Our trial build targets the stock bootloader and partition table. It requires a verified factory fallback and leaves the trial boot unconfirmed, so the stock bootloader selects the factory image on exit. The saved factory preference controls the resulting screen. Is a third-party test listing supported, and what should the published app use to re-enter after return and retain its settings across factory updates? [Official App Center](https://docs.m5stack.com/en/StackChan/#app-center) · [Catalog interfaces](https://github.com/m5stack/StackChan/blob/main/server/README.MD#63-add-an-app-store-item) · [ESP-IDF OTA states](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/system/ota.html#app-ota-state)

## Verification to date

The public menu was built with the feature enabled and disabled. Host fixtures exercise the reference selector in 36 cases and also cover App Visibility, the pending-update guard, and the one-time Home handoff. With the v49 independent app, QEMU exercised 12 public launcher boot and update cases. A separate offline run against a saved factory baseline exercised 9 boot handoffs and 10 interrupted install or restore stages. For the stock-bootloader trial, 10 whole-Flash readback cases covered fallback after an unconfirmed start, partial staging, a torn OTA selection record and an incomplete settings ownership record. Offline restoration matched the original read byte for byte. The QEMU runs stop at the app entry or HAL initialization boundary. The production launcher, online assistant, existing phone binding and physical device remain hardware acceptance items.

## Reproduce the local review

Use the project's pinned SDK environment at the repository root.

```sh
python3 scripts/prepare_agent_menu.py --destination work/menu-review-source
python3 scripts/test_agent_menu.py --prepared work/menu-review-source
python3 scripts/export_agent_menu_review.py --prepared work/menu-review-source \
  --destination work/menu-review-export --archive work/menu-review-export.zip
```

From a clean checkout of the pinned StackChan commit, apply the patch and run the exported host tests. The test runner checks the checkout commit and the SHA-256 of the patched files and exported sources, then compiles the C and C++ fixtures with Clang and the address and undefined-behavior sanitizers. This step uses the export and the public checkout as its only project inputs.

```sh
review=/absolute/path/to/menu-review-export
git apply --check "$review/launcher.patch"
git apply "$review/launcher.patch"
python3 "$review/tests/run.py" --stock "$PWD"
```

For a target build, prepare the normal StackChan firmware component sources and use [ESP-IDF v6.1 at `fff9895c82d744c7237be8847347bdd1b07c6643`](https://github.com/espressif/esp-idf/tree/fff9895c82d744c7237be8847347bdd1b07c6643). The upstream defaults exercise the disabled profile. For the enabled build, add the review fragment as the second SDK defaults file. Use separate build and SDK configuration paths for both profiles.

```sh
idf.py -C firmware -B build-menu-review -DIDF_TARGET=esp32s3 \
  -DSDKCONFIG=build-menu-review/sdkconfig \
  "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;/path/to/sdkconfig.menu.defaults" build
```

The reference selector can be compiled with the SDK commit in `selector/stock-sdk.lock.json` and `sdkconfig.stock.defaults`. The selector's build retains the public factory partition CSV. An integrated boot test also needs a reviewed layout that allocates the independent app and settings outside the two factory OTA slots. The export contains source, build configuration and host fixtures.
