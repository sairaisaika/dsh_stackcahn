idf_component_register(SRCS "reopen_probe.cc" PRIV_REQUIRES app_update esp_partition spi_flash)
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_ota_set_boot_partition")
