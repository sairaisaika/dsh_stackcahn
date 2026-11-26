idf_component_register(SRCS "ota_writer_probe.c" PRIV_REQUIRES app_update spi_flash esp_partition)
target_link_libraries(${COMPONENT_LIB} INTERFACE "-Wl,--wrap=esp_partition_erase_range")
