// SPDX-License-Identifier: MIT
#include "factory_caption_font.h"
#include <esp_err.h>
#include <esp_heap_caps.h>
#include <esp_partition.h>
#include <lvgl.h>
#include <src/font/fmt_txt/lv_font_fmt_txt.h>
#include <psa/crypto.h>
#include <array>
#include <cstring>

LV_FONT_DECLARE(BUILTIN_TEXT_FONT);

namespace sion::agent {
namespace {
// Public factory format and one reviewed Puhui build. A different font must
// pass a separate layout/ABI review before it can be used by LVGL.
constexpr char kFile[] = "font_puhui_common_20_4.bin";
constexpr size_t kFontSize = 1240332;
constexpr std::array<uint8_t,32> kFontSha256{
    0x91,0x28,0x29,0xae,0x9d,0x46,0x47,0x34,0x6e,0x74,0x02,0xeb,0x76,0xda,0x26,0x02,
    0x3a,0xc6,0xb4,0x7b,0x0b,0x27,0x77,0x82,0xa6,0x53,0x1e,0x46,0x6a,0x66,0x9c,0x02
};
constexpr size_t kCatalogHeader = 12, kCatalogEntry = 44, kMaxFiles = 128;
constexpr size_t kCbinDescriptor = 36, kCbinCmapEntry = 20, kCbinCmapCount = 27;
static_assert(sizeof(lv_font_fmt_txt_glyph_dsc_t)==16 && alignof(lv_font_fmt_txt_glyph_dsc_t)==4);
static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__);

uint16_t Le16(const uint8_t* p) { return uint16_t(p[0]) | (uint16_t(p[1])<<8); }
uint32_t Le32(const uint8_t* p) { return uint32_t(Le16(p)) | (uint32_t(Le16(p+2))<<16); }

const esp_partition_t* AssetPartition() {
    const auto* part=esp_partition_find_first(ESP_PARTITION_TYPE_DATA,static_cast<esp_partition_subtype_t>(0x82),"assets");
    return part&&part->address==0xa00000&&part->size==0x400000&&!part->encrypted?part:nullptr;
}

// Return an offset after the two-byte factory marker, or zero on mismatch.
size_t FindFont(const esp_partition_t* part) {
    std::array<uint8_t,kCatalogHeader> header{};
    if(esp_partition_read(part,0,header.data(),header.size())!=ESP_OK)return 0;
    const size_t count=Le32(header.data()), length=Le32(header.data()+8);
    if(count==0||count>kMaxFiles||length>part->size-kCatalogHeader||count*kCatalogEntry>length)return 0;
    const size_t base=kCatalogHeader+count*kCatalogEntry, payload=length-count*kCatalogEntry;
    size_t result=0;
    for(size_t i=0;i<count;++i) {
        std::array<uint8_t,kCatalogEntry> entry{};
        if(esp_partition_read(part,kCatalogHeader+i*kCatalogEntry,entry.data(),entry.size())!=ESP_OK)return 0;
        if(std::memcmp(entry.data(),kFile,sizeof(kFile))!=0)continue;
        const size_t size=Le32(entry.data()+32), offset=Le32(entry.data()+36);
        if(result||size!=kFontSize||offset>payload||payload-offset<2+kFontSize)return 0;
        std::array<uint8_t,2> marker{};
        if(esp_partition_read(part,base+offset,marker.data(),marker.size())!=ESP_OK||marker[0]!='Z'||marker[1]!='Z')return 0;
        result=base+offset+marker.size();
    }
    return result;
}

bool ReviewedBytes(const uint8_t* bytes) {
    std::array<uint8_t,32> hash{};
    size_t length=0;
    return psa_crypto_init()==PSA_SUCCESS&&
        psa_hash_compute(PSA_ALG_SHA_256,bytes,kFontSize,hash.data(),hash.size(),&length)==PSA_SUCCESS&&
        length==hash.size()&&hash==kFontSha256;
}

uint8_t* font_bytes=nullptr;
bool attempted=false;
lv_font_t font{};
lv_font_fmt_txt_dsc_t descriptor{};
lv_font_fmt_txt_kern_classes_t kerning{};
std::array<lv_font_fmt_txt_cmap_t,kCbinCmapCount> cmaps{};

// Rebind the reviewed 32-bit CBIN offsets into native LVGL descriptors; never
// copy the serialized callback pointers or use the allocating CBIN loader.
void BindFont(const uint8_t* bytes) {
    const auto* d=bytes+kCbinDescriptor;
    const auto* cmap=d+Le32(d+8);
    const auto* kern=d+Le32(d+12);
    for(size_t i=0;i<cmaps.size();++i) {
        const auto* row=cmap+i*kCbinCmapEntry;
        const auto unicode=Le32(row+8), glyph=Le32(row+12);
        cmaps[i]={Le32(row),Le16(row+4),Le16(row+6),
            unicode?reinterpret_cast<const uint16_t*>(cmap+unicode):nullptr,
            glyph?cmap+glyph:nullptr,Le16(row+16),static_cast<lv_font_fmt_txt_cmap_type_t>(row[18])};
    }
    kerning={reinterpret_cast<const int8_t*>(kern+Le32(kern)),kern+Le32(kern+4),kern+Le32(kern+8),kern[12],kern[13]};
    descriptor.glyph_bitmap=d+Le32(d);
    descriptor.glyph_dsc=reinterpret_cast<const lv_font_fmt_txt_glyph_dsc_t*>(d+Le32(d+4));
    descriptor.cmaps=cmaps.data();
    descriptor.kern_dsc=&kerning;
    descriptor.kern_scale=Le16(d+16);
    descriptor.cmap_num=kCbinCmapCount;
    descriptor.bpp=4;
    descriptor.kern_classes=1;
    descriptor.bitmap_format=LV_FONT_FMT_TXT_PLAIN;
    font.get_glyph_dsc=lv_font_get_glyph_dsc_fmt_txt;
    font.get_glyph_bitmap=lv_font_get_bitmap_fmt_txt;
    font.line_height=25;
    font.base_line=6;
    font.underline_position=-1;
    font.underline_thickness=1;
    font.dsc=&descriptor;
    font.fallback=&BUILTIN_TEXT_FONT;
}
}

void PrepareFactoryCaptionFont() {
    if(attempted)return;
    attempted=true;
    const auto* part=AssetPartition();
    const auto offset=part?FindFont(part):0;
    if(!offset)return;
    // The asset starts immediately after an unaligned pad. Load into PSRAM
    // so typed glyph and cmap reads have their documented alignment.
    auto* bytes=static_cast<uint8_t*>(heap_caps_malloc(kFontSize,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
    if(!bytes)return;
    if(esp_partition_read(part,offset,bytes,kFontSize)!=ESP_OK||!ReviewedBytes(bytes)) {
        heap_caps_free(bytes);
        return;
    }
    BindFont(bytes);
    font_bytes=bytes;
}

const _lv_font_t* FactoryCaptionFont() { return font_bytes?&font:nullptr; }

void ReleaseFactoryCaptionFont() {
    if(font_bytes)heap_caps_free(font_bytes);
    font_bytes=nullptr;
    attempted=false;
}
}
