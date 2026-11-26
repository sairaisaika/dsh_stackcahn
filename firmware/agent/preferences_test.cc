// SPDX-License-Identifier: MIT
#include "preferences.h"
#include <cassert>
#include <iostream>
using namespace sion::agent;
struct Port : AudioPort {
    int volume=-1;
    bool Open(int v) override { volume=v;return true; }
    bool Volume(int v) override { volume=v;return true; }
    bool Read(InputPcm&) override { return true; }
    bool Write(const OutputPcm&) override { return true; }
    bool Close() override { return true; }
};
struct Store : PreferenceStore {
    PreferenceLoad result=PreferenceLoad::Missing; Preferences stored{}; bool ok=true;int saves=0;
    PreferenceLoad Load(Preferences& out) override {if(result==PreferenceLoad::Loaded)out=stored;return result;}
    bool Save(const Preferences& value) override {++saves;if(!ok)return false;stored=value;result=PreferenceLoad::Loaded;return true;}
};
struct Camera:CameraPort {
    int opens=0,closes=0;
    bool Open()override{++opens;return true;}
    Result Read(uint8_t*,size_t,CameraImageInfo&)override{return Result::Pending;}
    bool Close()override{++closes;return true;}
};
void checksum(PreferenceRecord& b) {
    auto crc=PreferenceCrc(b.data(),8);
    for(int i=0;i<4;++i)b[8+i]=static_cast<uint8_t>(crc>>(8*i));
}
int main() {
    Preferences value{77,true,true,123,true,true,true};value.wake_standby=false;
    auto bytes=EncodePreferences(value);Preferences decoded;
    assert(bytes[0]==8&&DecodePreferences(bytes,decoded) && decoded.volume==77 && decoded.muted && decoded.microphone_disabled && decoded.revision==123&&decoded.camera_allowed&&decoded.motion_allowed&&decoded.ring_allowed);
    auto version2=bytes;version2[0]=2;version2[2]&=7;checksum(version2);
    assert(DecodePreferences(version2,decoded)&&decoded.camera_allowed&&!decoded.motion_allowed);
    version2[2]|=8;checksum(version2);assert(!DecodePreferences(version2,decoded));
    auto legacy=bytes;legacy[0]=1;legacy[2]&=3;checksum(legacy);
    assert(DecodePreferences(legacy,decoded)&&!decoded.camera_allowed&&decoded.revision==123&&decoded.volume==77);
    legacy[2]|=4;checksum(legacy);assert(!DecodePreferences(legacy,decoded));
    auto version3=bytes;version3[0]=3;version3[2]&=15;checksum(version3);
    assert(DecodePreferences(version3,decoded)&&decoded.motion_allowed&&!decoded.ring_allowed);
    version3[2]|=16;checksum(version3);assert(!DecodePreferences(version3,decoded));
    auto unknown=bytes;unknown[2]|=32;checksum(unknown);assert(!DecodePreferences(unknown,decoded));
    // Preserve Default for every older record; Whale remains an explicit choice.
    assert(DecodePreferences(bytes,decoded)&&decoded.appearance==Appearance::Default);
    assert(DecodePreferences(version3,decoded)==false);
    version3[2]&=15;checksum(version3);assert(DecodePreferences(version3,decoded)&&decoded.appearance==Appearance::Default);
    auto version4=bytes;version4[0]=4;checksum(version4);
    assert(DecodePreferences(version4,decoded)&&decoded.appearance==Appearance::Default&&decoded.ring_allowed);
    for (uint8_t version=1;version<=6;++version) {
        auto old_default=bytes;old_default[0]=version;
        old_default[2]&=version==1?3:version==2?7:version==3?15:31;
        checksum(old_default);
        // Records from before the standby choice read as standby on.
        assert(DecodePreferences(old_default,decoded)&&decoded.appearance==Appearance::Default&&decoded.wake_standby);
    }
    auto invalid_legacy=version4;invalid_legacy[3]=1;checksum(invalid_legacy);assert(!DecodePreferences(invalid_legacy,decoded));
    value.appearance=Appearance::Whale;
    auto whale=EncodePreferences(value);
    assert(whale[0]==8&&whale[3]==3&&DecodePreferences(whale,decoded)&&decoded.appearance==Appearance::Whale);
    auto invalid_whale=whale;invalid_whale[3]=4;checksum(invalid_whale);assert(!DecodePreferences(invalid_whale,decoded));
    value.appearance=Appearance::Fish;
    auto fish=EncodePreferences(value);
    assert(fish[0]==8&&fish[3]==1&&DecodePreferences(fish,decoded)&&decoded.appearance==Appearance::Fish&&decoded.ring_allowed);
    auto invalid_fish=fish;invalid_fish[3]=4;checksum(invalid_fish);assert(!DecodePreferences(invalid_fish,decoded));
    invalid_fish=fish;invalid_fish[2]|=32;checksum(invalid_fish);assert(!DecodePreferences(invalid_fish,decoded));
    value.appearance=Appearance::Text;
    assert(DecodePreferences(EncodePreferences(value),decoded)&&decoded.appearance==Appearance::Text);
    // Standby on is a version 7 record, an explicit off is version 8.
    value.appearance=Appearance::Fish;value.wake_standby=true;
    auto standby=EncodePreferences(value);
    assert(standby[0]==7&&(standby[2]&32)&&DecodePreferences(standby,decoded)&&decoded.wake_standby&&
           decoded.appearance==Appearance::Fish&&decoded.ring_allowed);
    auto invalid_standby=standby;invalid_standby[2]|=64;checksum(invalid_standby);assert(!DecodePreferences(invalid_standby,decoded));
    invalid_standby=standby;invalid_standby[0]=8;checksum(invalid_standby);assert(!DecodePreferences(invalid_standby,decoded));
    invalid_standby=standby;invalid_standby[3]=4;checksum(invalid_standby);assert(!DecodePreferences(invalid_standby,decoded));
    value.wake_standby=false;
    assert(EncodePreferences(value)[0]==8&&DecodePreferences(EncodePreferences(value),decoded)&&!decoded.wake_standby);
    assert(DecodePreferences(whale,decoded)&&!decoded.wake_standby);
    for(size_t i=0;i<bytes.size();++i){auto corrupt=bytes;corrupt[i]^=1;assert(!DecodePreferences(corrupt,decoded));}
    Port port;AudioEngine audio(port);Store store;DevicePreferences prefs(store,audio);
    prefs.Load(0);assert(prefs.value().volume==0 && prefs.dirty() && store.saves==0);
    prefs.Volume(65);assert(prefs.Save() && !prefs.dirty() && store.stored.revision==1);
    DevicePreferences reload(store,audio);reload.Load(90);assert(reload.value().volume==65);
    reload.SetAppearance(Appearance::Fish);
    assert(reload.dirty()&&reload.Save());
    prefs.Load(90);assert(prefs.value().appearance==Appearance::Fish&&prefs.value().volume==65);
    prefs.SetAppearance(Appearance::Default);
    assert(prefs.Save()&&EncodePreferences(store.stored)[0]==7&&store.stored.wake_standby); // on by default
    prefs.SetWakeStandby(false);
    assert(prefs.dirty()&&store.stored.wake_standby&&prefs.Save()&&!store.stored.wake_standby);
    prefs.SetWakeStandby(false);assert(!prefs.dirty());
    reload.Load(90);assert(!reload.value().wake_standby&&EncodePreferences(store.stored)[0]==8);
    prefs.SetWakeStandby(true);assert(prefs.Save()&&EncodePreferences(store.stored)[0]==7);
    assert(audio.Begin(1));audio.Pump(0);assert(port.volume==65);
    prefs.Mute(true);audio.Pump(0);assert(port.volume==0);
    prefs.DisableMicrophone(true);assert(!audio.Begin(2));audio.Pump(0);
    assert(audio.status().phase==AudioPhase::Idle && !audio.Begin(2));
    prefs.DisableMicrophone(false);assert(audio.status().phase==AudioPhase::Idle);
    store.ok=false;assert(!prefs.Save() && prefs.dirty() && prefs.save_error());
    for(auto bad:{PreferenceLoad::Unavailable,PreferenceLoad::Error}) {
        Store failed;failed.result=bad;DevicePreferences safe(failed,audio);safe.Load(90);
        assert(safe.value().muted && safe.value().microphone_disabled && !audio.Begin(3));
        assert(!safe.Save() && failed.saves==0);
    }
    {
        Port ap;AudioEngine ae(ap);Camera cp;CameraEngine ce(cp);Store s;
        DevicePreferences p(s,ae,&ce);p.Load(40);assert(!ce.status().allowed&&cp.opens==0);
        p.AllowCamera(true);assert(ce.status().allowed&&cp.opens==0&&p.dirty());
        assert(p.Save()&&s.stored.camera_allowed);
        DevicePreferences loaded(s,ae,&ce);loaded.Load(0);assert(loaded.value().camera_allowed&&cp.opens==0);
        assert(ae.Begin(1));ae.Pump(0);auto t=ce.Begin(1,0);assert(t);ce.Pump(0);
        loaded.AllowCamera(false);assert(ce.status().phase==CameraPhase::Closing&&ae.status().phase==AudioPhase::Running);
        ce.Pump(1);assert(cp.closes==1);loaded.AllowCamera(true);assert(ce.Begin(1,2)>t);
        ce.Stop(2);ce.Pump(3);ae.Stop(2);ae.Pump(0);
        s.result=PreferenceLoad::Missing;loaded.Load(40);assert(!loaded.value().camera_allowed&&!ce.status().allowed);
        s.result=PreferenceLoad::Error;loaded.Load(40);assert(!loaded.value().camera_allowed&&!ce.status().allowed);
    }
    std::cout<<"Preferences: CRC, initial mute, durable reload, unsaved failure and capture interlock passed\n";
}
