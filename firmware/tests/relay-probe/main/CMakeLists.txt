set(agent "../../../agent")
idf_component_register(SRCS "probe.cc" "${agent}/agent_psk_tls.cc" INCLUDE_DIRS "${agent}"
    PRIV_REQUIRES mbedtls esp_driver_uart bootloader_support)
