# After-init hook for the stock v5.5.4 bootloader (wiki/boot-selector-power-key.md).
# The stock bootloader links this component through the bootloader_hooks_include symbol.
idf_build_get_property(idf_dir IDF_PATH)
if(EXISTS "${idf_dir}/components/esp_hal_gpio/CMakeLists.txt")
    set(gpio_component esp_hal_gpio)
else()
    set(gpio_component hal)
endif()
idf_component_register(SRCS "sion_pek.c"
                       REQUIRES bootloader_support
                       PRIV_REQUIRES ${gpio_component} esp_rom soc esp_app_format log spi_flash)
