// SPDX-License-Identifier: MIT
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SION_MENU_BOOT_VERSION 1146308610u
#define SION_MENU_REQUEST_BYTES 8

typedef enum {
    SION_MENU_NONE = 0,
    SION_MENU_ENTER_DSH = 1,
    SION_MENU_RETURN_STOCK = 2,
    SION_MENU_STOCK_READY = 3,
} sion_menu_request_t;

static const uint8_t sion_menu_request_tag[SION_MENU_REQUEST_BYTES - 1] = {
    'S', 'I', 'O', 'N', 'D', 'S', 'H',
};

static inline void sion_menu_arm(volatile uint8_t* memory, sion_menu_request_t request)
{
    memory[0] = 0;
    for (size_t i = 1; i < sizeof(sion_menu_request_tag); ++i) {
        memory[i] = sion_menu_request_tag[i];
    }
    memory[SION_MENU_REQUEST_BYTES - 1] = (uint8_t)request;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    memory[0] = sion_menu_request_tag[0];
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
}

static inline sion_menu_request_t sion_menu_consume(volatile uint8_t* memory, bool accepted_context)
{
    const uint8_t request = memory[SION_MENU_REQUEST_BYTES - 1];
    for (size_t i = 0; i < sizeof(sion_menu_request_tag); ++i) {
        if (memory[i] != sion_menu_request_tag[i]) accepted_context = false;
        // Clear even on an unexpected reset or torn request. No automatic retry.
        memory[i] = 0;
    }
    memory[SION_MENU_REQUEST_BYTES - 1] = 0;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    if (!accepted_context || request < SION_MENU_ENTER_DSH || request > SION_MENU_STOCK_READY) return SION_MENU_NONE;
    return (sion_menu_request_t)request;
}
