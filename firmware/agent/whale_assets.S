/* SPDX-License-Identifier: MIT */
/* Sprite blob for the whale face. Word aligned: LVGL reads RGB565 as uint16_t. */
    .section .rodata.sion_whale_assets,"a",@progbits
    .balign 4
    .global sion_whale_assets_start
sion_whale_assets_start:
    .incbin "whale_assets.bin"
    .global sion_whale_assets_end
sion_whale_assets_end:
    .section .note.GNU-stack,"",@progbits
