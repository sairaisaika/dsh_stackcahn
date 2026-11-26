#pragma once
#include "FreeRTOS.h"
using EventBits_t=uint32_t;
using EventGroupHandle_t=uint32_t*;
inline EventGroupHandle_t xEventGroupCreate(){return new uint32_t(0);}
inline void vEventGroupDelete(EventGroupHandle_t p){delete p;}
inline void xEventGroupSetBits(EventGroupHandle_t p,uint32_t bits){*p|=bits;}
inline void xEventGroupClearBits(EventGroupHandle_t p,uint32_t bits){*p&=~bits;}
inline uint32_t xEventGroupWaitBits(EventGroupHandle_t p,uint32_t bits,bool clear,bool,uint32_t){auto r=*p&bits;if(clear)*p&=~bits;return r;}
