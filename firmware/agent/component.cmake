target_sources(${COMPONENT_LIB} PRIVATE "agent/storage_guard.cc" "agent/settings_store.cc" "agent/pairing_store.cc" "agent/pairing_service.cc" "agent/pairing_usb.cc" "agent/agent_session.cc" "agent/agent_network.cc" "agent/agent_psk_tls.cc" "agent/agent_relay_config.cc" "agent/agent_display.cc" "agent/camera_port.cc" "agent/camera_runtime.cc" "agent/motion_scs.cc" "agent/motion_uart.cc" "agent/motion_power.cc" "agent/py32_expander.cc" "agent/ring_port.cc" "agent/ring_runtime.cc" "agent/motion_hardware.cc" "agent/motion_runtime.cc" "agent/audio_runtime.cc" "agent/core_audio_bridge.cc")
include("${CMAKE_CURRENT_LIST_DIR}/disable_ws_redirect.cmake")
target_sources(${COMPONENT_LIB} PRIVATE "agent/factory_caption_font.cc")
target_sources(${COMPONENT_LIB} PRIVATE "agent/ambient_runtime.cc")
target_sources(${COMPONENT_LIB} PRIVATE "agent/ir_runtime.cc")
target_sources(${COMPONENT_LIB} PRIVATE "agent/nfc_runtime.cc")
target_sources(${COMPONENT_LIB} PRIVATE "agent/device_trace.cc")
foreach(symbol nvs_open nvs_open_from_partition nvs_flash_erase nvs_flash_erase_partition
               esp_ota_begin esp_ota_write esp_ota_set_boot_partition
               esp_ota_mark_app_valid_cancel_rollback esp_ota_mark_app_invalid_rollback_and_reboot
               esp_partition_write esp_partition_write_raw esp_partition_erase_range)
    target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=${symbol}")
endforeach()
# Whale face: generated sprite blob (scripts/build_whale_avatar.mjs), word aligned.
target_sources(${COMPONENT_LIB} PRIVATE "agent/whale_assets.cc" "agent/whale_assets.S")
set_property(SOURCE "${CMAKE_CURRENT_LIST_DIR}/whale_assets.S" APPEND PROPERTY
             OBJECT_DEPENDS "${CMAKE_CURRENT_LIST_DIR}/whale_assets.bin")
# .incbin resolves against the assembler's own include path, not the compiler's.
set_property(SOURCE "${CMAKE_CURRENT_LIST_DIR}/whale_assets.S" APPEND PROPERTY
             COMPILE_OPTIONS "-Wa,-I${CMAKE_CURRENT_LIST_DIR}")
# Body-health sampler for heat and freeze diagnosis; observation only.
target_sources(${COMPONENT_LIB} PRIVATE "agent/device_health.cc")
