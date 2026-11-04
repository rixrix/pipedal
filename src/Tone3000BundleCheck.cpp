// SPDX-License-Identifier: MIT
#include "Tone3000BundleCheck.hpp"
#include "Tone3000Library.hpp"
#include "Banks.hpp"
#include "AesDigest.hpp"
#include "PiPedalException.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <set>
#include <sstream>
#include <sys/stat.h>
#include <zip.h>
using namespace pipedal;
JSON_MAP_BEGIN(Tone3000BundlePlugin)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,uri)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,name)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,versionStatus)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,installed)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,requiredMinor)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,requiredMicro)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,installedMinor)
JSON_MAP_REFERENCE(Tone3000BundlePlugin,installedMicro)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000BundleReport)
JSON_MAP_REFERENCE(Tone3000BundleReport,name)
JSON_MAP_REFERENCE(Tone3000BundleReport,sha256)
JSON_MAP_REFERENCE(Tone3000BundleReport,archive)
JSON_MAP_REFERENCE(Tone3000BundleReport,knownAssetsPresent)
JSON_MAP_REFERENCE(Tone3000BundleReport,completenessKnown)
JSON_MAP_REFERENCE(Tone3000BundleReport,readinessProven)
JSON_MAP_REFERENCE(Tone3000BundleReport,presetCount)
JSON_MAP_REFERENCE(Tone3000BundleReport,namCount)
JSON_MAP_REFERENCE(Tone3000BundleReport,irCount)
JSON_MAP_REFERENCE(Tone3000BundleReport,embeddedBytes)
JSON_MAP_REFERENCE(Tone3000BundleReport,opaqueStates)
JSON_MAP_REFERENCE(Tone3000BundleReport,incompleteToneStates)
JSON_MAP_REFERENCE(Tone3000BundleReport,plugins)
JSON_MAP_REFERENCE(Tone3000BundleReport,missingMedia)
JSON_MAP_REFERENCE(Tone3000BundleReport,warnings)
JSON_MAP_END()
namespace {
[[noreturn]] void Fail(const char* text){throw PiPedalArgumentException(text);}
void JsonBound(const std::string& text){
    size_t depth=0,nodes=0;bool string=false,escape=false;
    for(unsigned char c:text){
        if(string){if(escape)escape=false;else if(c=='\\')escape=true;else if(c=='"')string=false;continue;}
        if(c=='"'){string=true;if(++nodes>200000)Fail("Bundle JSON exceeds its field bound.");}
        else if(c=='{'||c=='['){if(++depth>128)Fail("Bundle JSON is too deeply nested.");if(++nodes>200000)Fail("Bundle JSON exceeds its field bound.");}
        else if(c==','){if(++nodes>200000)Fail("Bundle JSON exceeds its field bound.");}
        else if(c=='}'||c==']'){if(!depth)Fail("Malformed bundle JSON.");--depth;}
    }
    if(string||depth)Fail("Malformed bundle JSON.");
}
struct Zip {zip_t* value=nullptr;~Zip(){if(value)zip_discard(value);}};
struct Entry{zip_uint64_t index=0,size=0;};
std::string Read(zip_t* archive,const Entry& entry,bool retain){
    zip_file_t* stream=zip_fopen_index(archive,entry.index,0);if(!stream)Fail("Unreadable bundle entry.");
    std::string result;size_t total=0;std::array<char,16384> buffer;
    if(retain)result.reserve(entry.size);
    try{
        for(;;){auto count=zip_fread(stream,buffer.data(),buffer.size());if(count<0)Fail("Bundle entry checksum/read failure.");if(!count)break;
            if(static_cast<uint64_t>(count)>entry.size-total)Fail("Bundle entry expands beyond its declared size.");total+=count;
            if(retain)result.append(buffer.data(),count);
        }
        if(total!=entry.size)Fail("Truncated bundle entry.");
        if(zip_fclose(stream)!=0){stream=nullptr;Fail("Bundle entry checksum failure.");}stream=nullptr;return result;
    }catch(...){if(stream)zip_fclose(stream);throw;}
}
std::optional<uint32_t> Version(const json_variant& value){
    double number=-1;
    if(value.is_number())number=value.as_number();
    else if(value.is_string()){
        const auto text=value.as_string();if(text.empty()||text.size()>10||!std::all_of(text.begin(),text.end(),[](char c){return c>='0'&&c<='9';}))return {};
        number=std::stod(text);
    }
    if(!std::isfinite(number)||number<0||number>4294967295.0||std::floor(number)!=number)return {};return static_cast<uint32_t>(number);
}
std::string StatePath(const std::vector<uint8_t>& bytes){
    size_t size=bytes.size();while(size&&bytes[size-1]==0)--size;return std::string(bytes.begin(),bytes.begin()+size);
}
}
bool Tone3000BundleCheck::SafeEntry(const std::string& name){
    if(name.empty()||name.size()>1024||name.front()=='/'||name.find('\\')!=std::string::npos||name.find(':')!=std::string::npos)return false;
    for(unsigned char c:name)if(c<32||c==127)return false;
    std::istringstream stream(name);std::string component;
    while(std::getline(stream,component,'/'))if(component.empty()||component=="."||component=="..")return false;
    return true;
}
Tone3000BundleReport Tone3000BundleCheck::Check(const std::filesystem::path& file,const Resolver& installed) try {
    const auto raw=Tone3000Library::ReadFile(file,MAX_FILE);if(raw.empty())Fail("Empty rig bundle.");
    Tone3000BundleReport result;result.sha256_=AesDigest(std::string(raw.begin(),raw.end()));
    result.archive_=raw.size()>=2&&raw[0]=='P'&&raw[1]=='K';
    Zip archive;std::map<std::string,Entry> entries;std::string bankText,metadata;
    if(result.archive_){
        int error=0;archive.value=zip_open(file.c_str(),ZIP_RDONLY,&error);if(!archive.value)Fail("Invalid or unsupported rig archive.");
        const auto count=zip_get_num_entries(archive.value,0);if(count<1||count>2000)Fail("Archive entry count exceeds its bound.");
        uint64_t expanded=0;
        for(zip_uint64_t i=0;i<static_cast<zip_uint64_t>(count);++i){
            const char* name=zip_get_name(archive.value,i,0);if(!name||!SafeEntry(name)||entries.contains(name))Fail("Unsafe or duplicate archive entry.");
            zip_stat_t stat;zip_stat_init(&stat);if(zip_stat_index(archive.value,i,0,&stat)!=0||!(stat.valid&ZIP_STAT_SIZE))Fail("Invalid archive entry metadata.");
            if(stat.encryption_method!=ZIP_EM_NONE||stat.size>MAX_EXPANDED-expanded)Fail("Encrypted or oversized archive entry.");expanded+=stat.size;
            zip_uint8_t os=0;zip_uint32_t attributes=0;
            if(zip_file_get_external_attributes(archive.value,i,0,&os,&attributes)!=0)Fail("Invalid archive attributes.");
            const auto mode=(attributes>>16)&S_IFMT;
            if((os==ZIP_OPSYS_UNIX||os==ZIP_OPSYS_OS_X)&&mode!=0&&mode!=S_IFREG&&mode!=S_IFDIR)Fail("Linked or special archive entries are unsupported.");
            if((os==ZIP_OPSYS_UNIX||os==ZIP_OPSYS_OS_X)&&mode==S_IFDIR&&!std::string(name).ends_with('/'))Fail("Invalid directory entry name.");
            entries.emplace(name,Entry{i,stat.size});
        }
        if(!entries.contains("bankFile.json")||entries.at("bankFile.json").size>MAX_FILE)Fail("Missing or oversized bankFile.json.");
        bankText=Read(archive.value,entries.at("bankFile.json"),true);
        if(entries.contains("pluginsUsed.json")){
            if(entries.at("pluginsUsed.json").size>1024*1024)Fail("Plugin metadata is oversized.");metadata=Read(archive.value,entries.at("pluginsUsed.json"),true);
        }
        // Verify every payload/CRC, including unused media, without extracting it.
        for(const auto& [name,entry]:entries)if(name!="bankFile.json"&&name!="pluginsUsed.json")Read(archive.value,entry,false);
    }else bankText.assign(raw.begin(),raw.end());
    JsonBound(bankText);std::istringstream input(bankText);json_reader reader(input,false);BankFile bank;reader.read(&bank);
    input>>std::ws;if(!input.eof())Fail("Trailing data after bank JSON.");
    if(bank.presets().empty()||bank.presets().size()>128)Fail("Rig bundle must contain 1–128 presets.");
    result.name_=bank.name().substr(0,512);result.presetCount_=bank.presets().size();
    std::map<std::string,json_variant> versions;
    if(!metadata.empty()){
        JsonBound(metadata);std::istringstream stream(metadata);json_reader read(stream,false);json_variant value;read.read(&value);
        stream>>std::ws;if(!stream.eof())Fail("Trailing plugin metadata.");
        if(!value.is_array()||value.as_array()->size()>256)Fail("Unsupported plugin metadata.");
        for(const auto& item:*value.as_array()){
            if(!item.is_object()||!item.as_object()->contains("uri")||!item["uri"].is_string()||item["uri"].as_string().size()>4096||!versions.emplace(item["uri"].as_string(),item).second)Fail("Ambiguous plugin metadata.");
        }
    }
    std::map<std::string,std::string> required;std::set<std::string> media;std::set<int64_t> presets;
    auto path=[&](const std::string& value){if(value.empty())return;if(!SafeEntry(value)||value.ends_with('/'))Fail("Unsafe declared media path.");media.insert(value);if(media.size()>2000)Fail("Too many media dependencies.");};
    auto state=[&](const std::string& uri,const Lv2PluginState& value,bool snapshot){
        for(const auto& [key,entry]:value.values_)if(entry.atomType_=="http://lv2plug.in/ns/ext/atom#Path")path(StatePath(entry.value_));
        if(uri==Tone3000Preset::PLUGIN_URI){
            if(!value.isValid_||!value.values_.contains(Tone3000Preset::STATE_URI)){
                if(!snapshot||value.isValid_||!value.values_.empty())++result.incompleteToneStates_;
            }else{const auto info=Tone3000Preset::InspectState(value);result.namCount_+=info.namCount;result.irCount_+=info.irCount;result.embeddedBytes_+=info.embeddedBytes;}
        }else if(value.isValid_&&std::any_of(value.values_.begin(),value.values_.end(),[](const auto& entry){return entry.second.atomType_!="http://lv2plug.in/ns/ext/atom#Path";}))++result.opaqueStates_;
    };
    auto properties=[&](const std::map<std::string,std::string>& values){
        for(const auto& [key,text]:values){if(text.empty())continue;if(text.size()>1024*1024)Fail("Oversized path property.");JsonBound(text);
            std::istringstream stream(text);json_reader read(stream,false);json_variant value;read.read(&value);
            stream>>std::ws;if(!stream.eof())Fail("Trailing path property JSON.");
            if(value.is_object()&&value.as_object()->contains("otype_")&&value["otype_"].is_string()&&value["otype_"].as_string()=="Path"){
                if(!value.as_object()->contains("value")||!value["value"].is_string())Fail("Invalid media path property.");path(value["value"].as_string());
            }
        }
    };
    for(const auto& preset:bank.presets()){
        if(!preset)Fail("Null saved preset entry.");
        if(!presets.insert(preset->instanceId()).second)Fail("Duplicate saved preset identity.");
        auto& board=preset->preset();auto plugins=board.GetAllPlugins();if(plugins.size()>512||board.snapshots().size()>64)Fail("Rig structure exceeds its bound.");
        std::map<int64_t,std::string> uris;std::set<int64_t> structural;
        for(const auto* item:plugins){
            if(item->uri().empty()||item->uri().size()>4096||!uris.emplace(item->instanceId(),item->uri()).second)Fail("Invalid or duplicate plugin identity.");
            if(item->isEmpty()||item->isSplit()){structural.insert(item->instanceId());continue;}
            required[item->uri()]=item->pluginName().substr(0,512);state(item->uri(),item->lv2State(),false);properties(item->pathProperties_);
            if(required.size()>2000)Fail("Too many plugin dependencies.");
        }
        for(const auto& snapshot:board.snapshots())if(snapshot){
            if(snapshot->values_.size()>512)Fail("Snapshot structure exceeds its bound.");
            for(const auto& value:snapshot->values_){
                auto uri=uris.find(value.instanceId_);if(uri==uris.end())Fail("Snapshot refers to an unknown plugin.");
                if(structural.contains(value.instanceId_))continue;
                state(uri->second,value.lv2State_,true);properties(value.pathProperties_);
            }
        }
    }
    for(const auto& relative:media)if(!entries.contains("media/"+relative)||entries.at("media/"+relative).size==0||relative.ends_with(".mdata"))result.missingMedia_.push_back(relative);
    for(const auto& [uri,name]:required){
        Tone3000BundlePlugin plugin;plugin.uri_=uri;plugin.name_=name;const auto current=installed(uri);
        plugin.installed_=current.has_value();if(current){plugin.installedMinor_=current->minor;plugin.installedMicro_=current->micro;}
        auto found=versions.find(uri);
        if(found!=versions.end()){
            const auto& value=found->second;
            if(value.as_object()->contains("minorVersion"))plugin.requiredMinor_=Version(value["minorVersion"]);
            if(value.as_object()->contains("microVersion"))plugin.requiredMicro_=Version(value["microVersion"]);
        }
        if(!current)plugin.versionStatus_="missing";
        else if(plugin.requiredMinor_&&plugin.requiredMicro_&&(*plugin.requiredMinor_!=0||*plugin.requiredMicro_!=0))
            plugin.versionStatus_=*plugin.requiredMinor_==current->minor&&*plugin.requiredMicro_==current->micro?"match":"mismatch";
        result.plugins_.push_back(std::move(plugin));
    }
    result.knownAssetsPresent_=result.missingMedia_.empty()&&result.incompleteToneStates_==0;
    result.completenessKnown_=result.knownAssetsPresent_&&result.opaqueStates_==0;
    result.warnings_.push_back("LV2 version matches do not prove plugin-release/patch compatibility or audio readiness.");
    if(result.opaqueStates_)result.warnings_.push_back("Opaque third-party state may contain undeclared dependencies.");
    if(result.incompleteToneStates_)result.warnings_.push_back("TONE3000 program/preset references or absent full state are not self-contained.");
    if(!result.archive_)result.warnings_.push_back("Legacy JSON contains no external media archive or version evidence.");
    return result;
}catch(const std::filesystem::filesystem_error&){throw PiPedalStateException("Rig bundle input is unavailable.");}
