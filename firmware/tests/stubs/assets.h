#pragma once
#include <string>
struct Assets {
 struct Capability{bool glyph_push=false;std::string bundle,charset;int size=0,bpp=0;};
 static Assets& GetInstance(){static Assets a;return a;}
 Capability text_font_capability(){return {};}
};
