idf_component_register(
    SRCS "storage_probe.cc" "tail_storage.cc" "cJSON.c"
         "agent/storage_guard.cc" "agent/settings_store.cc"
         "agent/pairing_store.cc" "agent/agent_relay_config.cc"
    INCLUDE_DIRS "." "agent"
    PRIV_REQUIRES app_update bootloader_support mbedtls nvs_flash spi_flash)
foreach(symbol nvs_open nvs_open_from_partition nvs_flash_erase nvs_flash_erase_partition
               esp_partition_write esp_partition_write_raw esp_partition_erase_range)
    target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=${symbol}")
endforeach()
