// SPDX-License-Identifier: MIT
#pragma once
#include <mooncake.h>

struct _lv_obj_t;
class AppDshEntry final : public mooncake::AppAbility {
public:
    AppDshEntry();
    void onOpen() override;
    void onRunning() override;
    void onClose() override;

private:
    _lv_obj_t* page_ = nullptr;
};
