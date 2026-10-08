// SPDX-License-Identifier: MIT
#include "Tone3000Performance.hpp"
#include "Tone3000Library.hpp"
#include "AesDigest.hpp"
#include "PiPedalException.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <fcntl.h>
#include <set>
#include <sstream>
#include <unistd.h>
using namespace pipedal;
namespace fs=std::filesystem;
JSON_MAP_BEGIN(Tone3000PerformanceSource)
JSON_MAP_REFERENCE(Tone3000PerformanceSource,bankId)
JSON_MAP_REFERENCE(Tone3000PerformanceSource,presetId)
JSON_MAP_REFERENCE(Tone3000PerformanceSource,name)
JSON_MAP_REFERENCE(Tone3000PerformanceSource,revision)
JSON_MAP_REFERENCE(Tone3000PerformanceSource,bankName)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000PerformanceSources)
JSON_MAP_REFERENCE(Tone3000PerformanceSources,sources)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000PerformanceSelection)
JSON_MAP_REFERENCE(Tone3000PerformanceSelection,bankId)
JSON_MAP_REFERENCE(Tone3000PerformanceSelection,presetId)
JSON_MAP_REFERENCE(Tone3000PerformanceSelection,expectedRevision)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000PerformanceRequest)
JSON_MAP_REFERENCE(Tone3000PerformanceRequest,name)
JSON_MAP_REFERENCE(Tone3000PerformanceRequest,slots)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000PerformanceSlot)
JSON_MAP_REFERENCE(Tone3000PerformanceSlot,label)
JSON_MAP_REFERENCE(Tone3000PerformanceSlot,name)
JSON_MAP_REFERENCE(Tone3000PerformanceSlot,program)
JSON_MAP_REFERENCE(Tone3000PerformanceSlot,presetId)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000PerformanceResult)
JSON_MAP_REFERENCE(Tone3000PerformanceResult,bankId)
JSON_MAP_REFERENCE(Tone3000PerformanceResult,revision)
JSON_MAP_REFERENCE(Tone3000PerformanceResult,name)
JSON_MAP_REFERENCE(Tone3000PerformanceResult,slots)
JSON_MAP_END()
namespace {
template<class T> std::string Json(const T& value){std::ostringstream out;json_writer writer(out);writer.write(value);return out.str();}
bool Hash(const std::string& value){return value.size()==64&&std::all_of(value.begin(),value.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});}
void Keys(const json_variant& value,std::initializer_list<const char*> allowed){
    if(!value.is_object())throw PiPedalArgumentException("Expected performance request object.");
    for(const auto& [key,field]:*value.as_object())if(std::none_of(allowed.begin(),allowed.end(),[&](const char* x){return key==x;}))
        throw PiPedalArgumentException("Unknown performance request field.");
}
void Integer(const json_variant& value){if(!value.is_number()||!std::isfinite(value.as_number())||value.as_number()<0||value.as_number()>9007199254740991.0||value.as_number()!=std::floor(value.as_number()))throw PiPedalArgumentException("Invalid saved source identity.");}
/** Open every directory without following a link; use descriptor-relative publish.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BANK] [DES-SEC] [7.4]
 */
int Directory(const fs::path& path){
    if(!path.is_absolute()||path.lexically_normal()!=path)throw PiPedalArgumentException("Invalid performance storage directory.");
    int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
    if(fd<0)throw PiPedalStateException("Unable to open performance storage.");
    for(const auto& part:path.relative_path()){
        int next=openat(fd,part.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW);close(fd);
        if(next<0)throw PiPedalStateException("Performance storage is unavailable or linked.");fd=next;
    }return fd;
}
void Atomic(const fs::path& path,const std::string& text,bool replace,bool* published=nullptr){
    int directory=Directory(path.parent_path()),fd=-1;std::string temporary;bool staged=false;
    try {
        static std::atomic<uint64_t> counter{0};
        for(int attempt=0;attempt<64;++attempt){
            temporary=".performance-"+std::to_string(getpid())+"-"+std::to_string(++counter)+"-"+
                std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
            fd=openat(directory,temporary.c_str(),O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW,0600);
            if(fd>=0){staged=true;break;}
            if(errno!=EEXIST)throw PiPedalStateException("Unable to stage performance bank.");
        }
        if(fd<0)throw PiPedalStateException("Unable to stage performance bank.");
        size_t done=0;while(done<text.size()){
            const auto count=write(fd,text.data()+done,text.size()-done);
            if(count<0&&errno==EINTR)continue;
            if(count<=0)throw PiPedalStateException("Unable to write performance bank.");done+=count;
        }
        if(fsync(fd)!=0)throw PiPedalStateException("Unable to sync performance bank.");close(fd);fd=-1;
        int result=replace?renameat(directory,temporary.c_str(),directory,path.filename().c_str())
            :linkat(directory,temporary.c_str(),directory,path.filename().c_str(),0);
        if(result!=0)throw PiPedalStateException("Performance publication failed or destination exists.");
        if(published)*published=true;
        if(!replace)unlinkat(directory,temporary.c_str(),0);temporary.clear();
        if(fsync(directory)!=0)throw PiPedalStateException("Performance publication sync failed; inspect banks before retry.");
        close(directory);
    }catch(...){if(fd>=0)close(fd);if(staged&&!temporary.empty())unlinkat(directory,temporary.c_str(),0);close(directory);throw;}
}
}
std::string Tone3000Performance::Revision(const Pedalboard& board){return AesDigest(Json(board));}
std::string Tone3000Performance::Revision(const BankFile& bank){
    std::istringstream stream(Json(bank));json_reader reader(stream);json_variant value;reader.read(&value);
    // Selecting a preset is not a content/order revision.
    auto object=value.as_object();const auto selected=object->find("selectedPreset");
    if(selected!=object->end())object->erase(selected);return AesDigest(value.to_string());
}
void Tone3000Performance::Validate(const Tone3000PerformanceRequest& request){
    if(request.name_.empty()||request.name_.size()>96||std::all_of(request.name_.begin(),request.name_.end(),[](unsigned char c){return c==' ';}))throw PiPedalArgumentException("Enter a performance bank name (1–96 bytes).");
    for(unsigned char c:request.name_)if(c<32||c==127||c=='/'||c=='\\')throw PiPedalArgumentException("Invalid performance bank name.");
    if(request.slots_.size()!=4)throw PiPedalArgumentException("Choose exactly four saved rigs.");
    std::set<std::pair<int64_t,int64_t>> seen;
    for(const auto& slot:request.slots_)if(slot.bankId_<0||slot.presetId_<0||!Hash(slot.expectedRevision_)||!seen.insert({slot.bankId_,slot.presetId_}).second)
        throw PiPedalArgumentException("Choose four distinct saved rigs with current revisions.");
}
void Tone3000Performance::ValidateJson(const json_variant& value){
    Keys(value,{"name","slots"});
    if(!value.as_object()->contains("name")||!value["name"].is_string()||value["name"].as_string().size()>96||!value.as_object()->contains("slots")||!value["slots"].is_array()||value["slots"].as_array()->size()!=4)throw PiPedalArgumentException("Invalid performance request.");
    for(const auto& slot:*value["slots"].as_array()){
        Keys(slot,{"bankId","presetId","expectedRevision"});
        if(!slot.as_object()->contains("bankId")||!slot.as_object()->contains("presetId")||!slot.as_object()->contains("expectedRevision"))throw PiPedalArgumentException("Missing performance source identity.");
        Integer(slot["bankId"]);Integer(slot["presetId"]);
        if(!slot["expectedRevision"].is_string()||!Hash(slot["expectedRevision"].as_string()))throw PiPedalArgumentException("Invalid source revision.");
    }
}
BankFile Tone3000Performance::Prepare(const std::string& name,const std::vector<Pedalboard>& ordered){
    if(ordered.size()!=4)throw PiPedalArgumentException("Expected four ordered saved rigs.");
    BankFile bank;bank.name("TONE3000 Performance - "+name);
    for(size_t i=0;i<4;++i){auto source=ordered[i];auto board=source.DeepCopy();board.name(std::string(1,'A'+i)+" - "+board.name());bank.addPreset(board);}
    bank.selectedPreset(bank.presets().front()->instanceId());return bank;
}
Tone3000PerformanceResult Tone3000Performance::Result(int64_t bankId,const BankFile& bank){
    if(bank.presets().size()!=4)throw PiPedalArgumentException("Performance bank must contain four rigs.");
    Tone3000PerformanceResult result;result.bankId_=bankId;result.revision_=Revision(bank);result.name_=bank.name();
    for(size_t i=0;i<4;++i)result.slots_.push_back({std::string(1,'A'+i),bank.presets()[i]->preset().name(),static_cast<int>(i),bank.presets()[i]->instanceId()});return result;
}
int64_t Tone3000Performance::ProgramListenerHandle(const json_variant& request){
    Keys(request,{"handle"});if(!request.as_object()->contains("handle"))throw PiPedalArgumentException("Missing program listener handle.");
    Integer(request["handle"]);const auto result=static_cast<int64_t>(request["handle"].as_number());
    if(result<1)throw PiPedalArgumentException("Invalid program listener handle.");return result;
}
int64_t Tone3000Performance::BankId(const json_variant& request){
    Keys(request,{"bankId"});if(!request.as_object()->contains("bankId"))throw PiPedalArgumentException("Missing bank identity.");
    Integer(request["bankId"]);return static_cast<int64_t>(request["bankId"].as_number());
}
void Tone3000Performance::Publish(const fs::path& dataRoot,const fs::path& bankPath,const fs::path& indexPath,const BankFile& bank,const BankIndex& index){
    if(fs::exists(bankPath)||fs::is_symlink(fs::symlink_status(bankPath)))throw PiPedalStateException("Performance bank destination already exists.");
    const auto bankText=Json(bank),indexText=Json(index);
    if(bankText.size()>256*1024*1024||indexText.size()>16*1024*1024)throw PiPedalArgumentException("Performance bank publication exceeds its bound.");
    const auto original=Tone3000Library::ReadFile(indexPath,16*1024*1024);
    Tone3000Library::BackupFile(dataRoot,indexPath);
    bool published=false;
    try{Atomic(bankPath,bankText,false,&published);Atomic(indexPath,indexText,true);}
    catch(...){
        // An index fsync failure can happen after rename. Restore old bytes
        // before removing our bank; never leave a reference to a deleted file.
        if(published){
            try{Atomic(indexPath,std::string(original.begin(),original.end()),true);}
            catch(...){throw PiPedalStateException("Performance publication outcome is uncertain; inspect banks before retrying.");}
            std::error_code ignored;fs::remove(bankPath,ignored);
        }throw;
    }
}
