idf_build_get_property(idf_dir IDF_PATH)
if(EXISTS "${idf_dir}/components/esp_hal_gpio/CMakeLists.txt")
    set(gpio_component esp_hal_gpio)
else()
    set(gpio_component hal)
endif()
idf_component_register(SRCS "bootloader_start.c"
                       REQUIRES bootloader bootloader_support
                       PRIV_REQUIRES ${gpio_component} esp_rom soc)
idf_build_get_property(scripts BOOTLOADER_LINKER_SCRIPT)
target_linker_script(${COMPONENT_LIB} INTERFACE "${scripts}")
