// SPDX-License-Identifier: MIT
#pragma once
#include <string_view>
namespace sion::agent {
inline bool ValidExpression(std::string_view value) {
    return value=="neutral"||value=="happy"||value=="angry"||value=="sad"||value=="doubt"||value=="sleepy";
}
// Single application/LVGL owner. No queued animation or background hardware work.
struct ExpressionPort {
    virtual ~ExpressionPort()=default;
    virtual bool SetExpression(std::string_view value)=0;
    virtual void ResetExpression()=0;
};
}
