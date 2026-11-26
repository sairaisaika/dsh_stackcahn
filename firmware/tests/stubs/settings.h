#pragma once
#include <string>
#include <cassert>
struct Settings {
 inline static int reads=0;
 Settings(const std::string& ns,bool write){assert(ns=="websocket");assert(!write);++reads;}
 std::string GetString(const std::string& key){++reads;return key=="url"?"wss://factory.example/voice":"factory-only-secret";}
 int GetInt(const std::string&){++reads;return 1;}
};
