# Build the selector candidate (or the plain stock baseline with --baseline) with the stock
# ESP-IDF v5.5.4 toolchain into DEST. No device access.
set -eu
root=${0:A:h:h:h}; dest="${1:?destination}"; mode="${2:-}"
export IDF_SKIP_CHECK_SUBMODULES=1 IDF_PATH="$root/work/esp-idf-stock-v5.5.4" IDF_TOOLS_PATH="$root/work/idf-tools-stock-v5"
export PATH="$IDF_TOOLS_PATH/tools/xtensa-esp-elf/esp-14.2.0_20260121/xtensa-esp-elf/bin:$IDF_TOOLS_PATH/python_env/idf5.5_py3.13_env/bin:/opt/homebrew/bin:$PATH:$root/work/idf-tools/python_env/idf6.1_py3.15_env/bin"
[[ $(git -C "$IDF_PATH" rev-parse HEAD) == $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["commit"])' "${0:A:h}/stock-sdk.lock.json") ]]
rm -rf "$dest"; mkdir -p "$dest"; cp -R "${0:A:h}/." "$dest/"; rm -f "$dest/build.zsh"
[[ "$mode" == --baseline ]] && rm -rf "$dest/bootloader_components"
python "$IDF_PATH/tools/idf.py" -C "$dest" -DIDF_TARGET=esp32s3 -DSDKCONFIG_DEFAULTS=sdkconfig.stock.defaults bootloader > "$dest.log" 2>&1
ls -la "$dest/build/bootloader/bootloader.bin"
