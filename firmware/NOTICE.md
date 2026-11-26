# Third-party source

`overlay/sion/paired_tls.h` and `paired_tls.cc` derive from `src/esp/esp_ssl.h`
and `esp_ssl.cc` in 78/esp-ml307, pinned in `upstream.lock.json` and the IDF
dependency lock. Their license is Apache-2.0, reproduced in
`licenses/Apache-2.0.txt`. Changes rename the class, inject a pairing-specific CA
and server name, bound the connection timeout, and wait for the receiver to exit
before freeing its TLS context. They do not modify the factory TLS trust store.

Other new Sion overlay files are MIT unless marked otherwise. Upstream patches
retain the licenses of the projects to which they apply.

`tests/vendor/cJSON/{cJSON.c,cJSON.h}` is unmodified cJSON 1.7.19,
MIT copyright Dave Gamble and cJSON contributors, with its LICENSE alongside.
Copied from the pinned ESP-IDF build's espressif/cjson dependency for offline
ASan/UBSan host tests. Production still links the IDF managed component.
Upstream: https://github.com/DaveGamble/cJSON/tree/v1.7.19 .

The independent Agent links the official `espressif/esp_websocket_client` 1.8.0
from esp-protocols commit `70bf122fc8bc74622dcf7e15233b5b2af9088df5`, Apache-2.0.
Source and license are retained by IDF Component Manager; the dependency is
pinned in `agent-dependencies.lock` and `scripts/prepare_agent.py`. The Apache
license text is also in `licenses/Apache-2.0.txt`. The local network worker and
bounded mailbox are original MIT code, not copies of the SDK implementation.

`tests/vendor/ftservo/{SCS.cpp,SCS.h,INST.h}` are unchanged from M5Stack
StackChan commit `28b9f0c8bd6acd81cb3c70f1a93c3e373b39d400`, directory
`firmware/main/hal/drivers/FTServo_Arduino/src`. The adjacent upstream LICENSE
is MIT, copyright (c) 2024 ftservo, retained here. These copies support offline
wire/adapter tests; production includes the same pinned upstream SCS header.
The new motion adapter does not use upstream SCSerial's unchecked UART teardown,
change servo EEPROM/calibration, or claim the test serial emulator is hardware.
