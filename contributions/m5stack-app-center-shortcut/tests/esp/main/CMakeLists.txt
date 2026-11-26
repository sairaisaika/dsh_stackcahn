idf_component_register(SRCS "shortcut_probe.cc" INCLUDE_DIRS "." PRIV_REQUIRES app_update spi_flash nvs_flash bootloader_support mbedtls)
target_compile_definitions(${COMPONENT_LIB} PRIVATE CONFIG_STACKCHAN_DSH_CATALOG_ID=31337)
