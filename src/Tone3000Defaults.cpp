// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#include "Tone3000Defaults.hpp"
#include "Tone3000Library.hpp"
#include "AesDigest.hpp"
#include "PiPedalException.hpp"
#include <libxml/parser.h>
#include <libxml/tree.h>
#include <cmath>
#include <cerrno>
#include <cstdlib>
#include <fcntl.h>
#include <iomanip>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>
using namespace pipedal;
namespace fs=std::filesystem;
JSON_MAP_BEGIN(Tone3000ProcessingDefaults)
JSON_MAP_REFERENCE(Tone3000ProcessingDefaults,multiCore)
JSON_MAP_REFERENCE(Tone3000ProcessingDefaults,namSlimSizeDefault)
JSON_MAP_REFERENCE(Tone3000ProcessingDefaults,calibrateInput)
JSON_MAP_REFERENCE(Tone3000ProcessingDefaults,inputCalibrationLevel)
JSON_MAP_REFERENCE(Tone3000ProcessingDefaults,osEnabled)
JSON_MAP_REFERENCE(Tone3000ProcessingDefaults,osFactor)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000ProcessingProfile)
JSON_MAP_REFERENCE(Tone3000ProcessingProfile,id)
JSON_MAP_REFERENCE(Tone3000ProcessingProfile,name)
JSON_MAP_REFERENCE(Tone3000ProcessingProfile,defaults)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000DefaultsResult)
JSON_MAP_REFERENCE(Tone3000DefaultsResult,revision)
JSON_MAP_REFERENCE(Tone3000DefaultsResult,activeProfile)
JSON_MAP_REFERENCE(Tone3000DefaultsResult,sourceStatus)
JSON_MAP_REFERENCE(Tone3000DefaultsResult,defaults)
JSON_MAP_REFERENCE(Tone3000DefaultsResult,profiles)
JSON_MAP_REFERENCE(Tone3000DefaultsResult,appDefaults)
JSON_MAP_REFERENCE(Tone3000DefaultsResult,warnings)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000DefaultsRequest)
JSON_MAP_REFERENCE(Tone3000DefaultsRequest,expectedRevision)
JSON_MAP_REFERENCE(Tone3000DefaultsRequest,activeProfile)
JSON_MAP_REFERENCE(Tone3000DefaultsRequest,defaults)
JSON_MAP_END()
namespace {
constexpr size_t MAX_XML=64*1024;
constexpr const char* PROFILE_KEY="pipedalTone3000Profiles";
using Bytes=std::vector<uint8_t>;
using Doc=std::unique_ptr<xmlDoc,decltype(&xmlFreeDoc)>;
struct ProfileData {
    int schemaVersion_=1;
    std::string activeProfile_="home";
    std::vector<Tone3000ProcessingProfile> profiles_;
    DECLARE_JSON_MAP(ProfileData);
};
JSON_MAP_BEGIN(ProfileData)
JSON_MAP_REFERENCE(ProfileData,schemaVersion)
JSON_MAP_REFERENCE(ProfileData,activeProfile)
JSON_MAP_REFERENCE(ProfileData,profiles)
JSON_MAP_END()
template<class T> std::string Json(const T& value) {std::ostringstream out;json_writer writer(out);writer.write(value);return out.str();}
std::string Digest(const Bytes& bytes) {return AesDigest(std::string(bytes.begin(),bytes.end()));}
void CheckPath(const fs::path& path) {
    if(!path.is_absolute() || path.lexically_normal()!=path) throw PiPedalArgumentException("Settings path is not normalized.");
    fs::path ancestor;
    for(const auto& component:path) {
        ancestor/=component;std::error_code error;auto status=fs::symlink_status(ancestor,error);
        if(error && error!=std::errc::no_such_file_or_directory) throw PiPedalStateException("Settings path is unavailable.");
        if(fs::is_symlink(status)) throw PiPedalArgumentException("Linked settings paths are not permitted.");
    }
}
std::optional<Bytes> Read(const fs::path& path) {
    CheckPath(path);
    std::error_code error;auto status=fs::symlink_status(path,error);
    if(status.type()==fs::file_type::not_found || error==std::errc::no_such_file_or_directory) return std::nullopt;
    return Tone3000Library::ReadFile(path,MAX_XML);
}
std::string Attribute(xmlNode* node,const char* name) {
    xmlChar* text=xmlGetProp(node,BAD_CAST name);if(!text) throw PiPedalArgumentException("Malformed settings value.");
    std::string result(reinterpret_cast<char*>(text));xmlFree(text);return result;
}
Doc Parse(const Bytes& bytes) {
    if(bytes.empty() || bytes.size()>MAX_XML) throw PiPedalArgumentException("Settings XML size is unsupported.");
    std::string text(bytes.begin(),bytes.end());
    if(text.find("<!DOCTYPE")!=std::string::npos || text.find("<!ENTITY")!=std::string::npos)
        throw PiPedalArgumentException("Settings DTD/entity declarations are not permitted.");
    Doc doc(xmlReadMemory(text.data(),text.size(),nullptr,nullptr,XML_PARSE_NONET|XML_PARSE_NOERROR|XML_PARSE_NOWARNING),xmlFreeDoc);
    if(!doc || doc->intSubset || doc->extSubset) throw PiPedalArgumentException("Malformed or unsupported settings XML.");
    auto root=xmlDocGetRootElement(doc.get());
    if(!root || xmlStrcmp(root->name,BAD_CAST "PROPERTIES")) throw PiPedalArgumentException("Unsupported settings XML root.");
    std::set<std::string> keys;
    for(auto node=root->children;node;node=node->next) {
        if(node->type==XML_COMMENT_NODE || node->type==XML_TEXT_NODE) continue;
        if(node->type!=XML_ELEMENT_NODE || xmlStrcmp(node->name,BAD_CAST "VALUE") || node->children)
            throw PiPedalArgumentException("Unsupported settings XML entry.");
        if(!keys.insert(Attribute(node,"name")).second) throw PiPedalArgumentException("Duplicate settings key.");
        Attribute(node,"val");
    }
    return doc;
}
std::map<std::string,std::string> Values(xmlDoc* doc) {
    std::map<std::string,std::string> result;
    for(auto node=xmlDocGetRootElement(doc)->children;node;node=node->next)
        if(node->type==XML_ELEMENT_NODE) result[Attribute(node,"name")]=Attribute(node,"val");
    return result;
}
double Number(const std::string& text) {
    size_t end=0;double value;
    try {value=std::stod(text,&end);} catch(...) {throw PiPedalArgumentException("Invalid processing default number.");}
    if(end!=text.size() || !std::isfinite(value)) throw PiPedalArgumentException("Invalid processing default number.");
    return value;
}
bool Boolean(const std::string& text) {
    if(text=="1" || text=="1.0" || text=="true") return true;
    if(text=="0" || text=="0.0" || text=="false") return false;
    auto value=Number(text);if(value!=0 && value!=1) throw PiPedalArgumentException("Invalid processing default boolean.");return value==1;
}
Tone3000ProcessingDefaults Processing(const std::map<std::string,std::string>& values) {
    Tone3000ProcessingDefaults out;
    for(const auto& [key,value]:values) {
        if(key=="multiCore") out.multiCore_=Boolean(value);
        else if(key=="namSlimSizeDefault") out.namSlimSizeDefault_=Number(value);
        else if(key=="calibrateInput") out.calibrateInput_=Boolean(value);
        else if(key=="inputCalibrationLevel") out.inputCalibrationLevel_=Number(value);
        else if(key=="osEnabled") out.osEnabled_=Boolean(value);
        else if(key=="osFactor") {auto n=Number(value);if(n!=std::floor(n) || n<0 || n>2) throw PiPedalArgumentException("Invalid oversampling factor.");out.osFactor_=static_cast<int>(n);}
    }
    Tone3000DefaultsStore::Validate(out);return out;
}
void Set(xmlDoc* doc,const char* key,const std::string& value) {
    auto root=xmlDocGetRootElement(doc);xmlNode* found=nullptr;
    for(auto node=root->children;node;node=node->next) if(node->type==XML_ELEMENT_NODE && Attribute(node,"name")==key) found=node;
    if(!found) {found=xmlNewChild(root,nullptr,BAD_CAST "VALUE",nullptr);xmlSetProp(found,BAD_CAST "name",BAD_CAST key);}
    xmlSetProp(found,BAD_CAST "val",BAD_CAST value.c_str());
}
std::string NumberText(double value) {std::ostringstream out;out<<std::setprecision(17)<<value;return out.str();}
void SetProcessing(xmlDoc* doc,const Tone3000ProcessingDefaults& d) {
    Set(doc,"multiCore",d.multiCore_?"1":"0");Set(doc,"namSlimSizeDefault",NumberText(d.namSlimSizeDefault_));
    Set(doc,"calibrateInput",d.calibrateInput_?"1":"0");Set(doc,"inputCalibrationLevel",NumberText(d.inputCalibrationLevel_));
    Set(doc,"osEnabled",d.osEnabled_?"1":"0");Set(doc,"osFactor",std::to_string(d.osFactor_));
}
bool ProfileId(const std::string& id) {return id=="home" || id=="studio" || id=="live";}
void ValidateProfiles(const ProfileData& data) {
    if(data.schemaVersion_!=1 || !ProfileId(data.activeProfile_) || data.profiles_.size()!=3) throw PiPedalArgumentException("Unsupported processing profiles.");
    std::set<std::string> ids;
    for(const auto& profile:data.profiles_) {
        if(!ProfileId(profile.id_) || profile.name_!=(profile.id_=="home"?"Home":profile.id_=="studio"?"Studio":"Live") || !ids.insert(profile.id_).second) throw PiPedalArgumentException("Invalid processing profile identity.");
        Tone3000DefaultsStore::Validate(profile.defaults_);
    }
}
fs::path ServiceFile() {
    const char* xdg=getenv("XDG_CONFIG_HOME");
    if(xdg && *xdg) return fs::path(xdg)/"TONE3000/preferences.settings";
    const char* home=getenv("HOME");if(!home || !*home) throw PiPedalStateException("Service HOME is unavailable.");
    return fs::path(home)/".config/TONE3000/preferences.settings";
}
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [DES-SEC] [3.12] */
Tone3000DefaultsStore::Tone3000DefaultsStore(const fs::path& dataRoot,const std::vector<std::string>& appRoots):dataRoot(dataRoot),serviceFile(ServiceFile()) {
    if(appRoots.size()>8) throw PiPedalArgumentException("Too many app preset roots.");
    for(const auto& root:appRoots) {
        fs::path path(root);
        if(!path.is_absolute() || path.lexically_normal()!=path)
            throw PiPedalArgumentException("Settings path is not normalized.");
        appSourceRoots.push_back(path);
        appFiles.push_back(path.parent_path()/"preferences.settings");
    }
}
Tone3000DefaultsStore::Tone3000DefaultsStore(const fs::path& dataRoot,const fs::path& serviceFile,std::vector<fs::path> appFiles):dataRoot(dataRoot),serviceFile(serviceFile),appFiles(std::move(appFiles)) {}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-OPERATE] [3.12] */
void Tone3000DefaultsStore::Validate(const Tone3000ProcessingDefaults& d) {
    if(!std::isfinite(d.namSlimSizeDefault_) || (d.namSlimSizeDefault_!=0 && d.namSlimSizeDefault_!=1)
       || !std::isfinite(d.inputCalibrationLevel_) || d.inputCalibrationLevel_<-60 || d.inputCalibrationLevel_>60 || d.osFactor_<0 || d.osFactor_>2)
        throw PiPedalArgumentException("Processing defaults are out of range.");
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [3.12] */
Tone3000DefaultsResult Tone3000DefaultsStore::Get() const try {
    Tone3000DefaultsResult result;
    // Optional app references must never prevent reading the authoritative
    // service profile. Recheck both configured roots and preference paths so
    // linked/unavailable sources stay excluded rather than silently trusted.
    // @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
    for(size_t i=0;i<appFiles.size();++i) try {
        if(i<appSourceRoots.size()) CheckPath(appSourceRoots[i]);
        auto bytes=Read(appFiles[i]);if(!bytes) continue;auto doc=Parse(*bytes);result.appDefaults_=Processing(Values(doc.get()));break;
    } catch(const std::exception&) {result.warnings_.push_back("T3K app defaults are unavailable or unsupported.");}
    auto bytes=Read(serviceFile);std::map<std::string,std::string> values;
    if(bytes) {auto doc=Parse(*bytes);values=Values(doc.get());}
    auto profile=values.find(PROFILE_KEY);
    if(profile!=values.end()) {
        ProfileData data;try {std::istringstream in(profile->second);json_reader reader(in);reader.read(&data);ValidateProfiles(data);} catch(const std::exception&) {throw PiPedalStateException("Unsupported service processing profiles.");}
        result.profiles_=data.profiles_;result.activeProfile_=data.activeProfile_;
        result.defaults_=Processing(values);
        for(const auto& p:result.profiles_) if(p.id_==result.activeProfile_ && Json(p.defaults_)!=Json(result.defaults_))
            throw PiPedalStateException("Active processing profile differs from processor keys; refresh or repair the service defaults.");
        result.sourceStatus_="service-profile";
    } else {
        if(result.appDefaults_) {result.defaults_=*result.appDefaults_;result.sourceStatus_="app-seed";}
        else if(bytes) {result.defaults_=Processing(values);result.sourceStatus_="service-seed";}
        else {result.sourceStatus_="pinned-defaults";}
        result.profiles_={{"home","Home",result.defaults_},{"studio","Studio",result.defaults_},{"live","Live",result.defaults_}};
    }
    // An absent service store also guards the displayed seed against app changes.
    result.revision_=AesDigest((bytes?Digest(*bytes):"absent")+(profile==values.end()?Json(result.defaults_):""));
    return result;
} catch(const fs::filesystem_error&) {throw PiPedalStateException("Processing settings storage is unavailable.");}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-12] [DES-OPERATE] [DES-SEC] [3.12] */
Tone3000DefaultsResult Tone3000DefaultsStore::Save(const Tone3000DefaultsRequest& request) try {
    Validate(request.defaults_);if(!ProfileId(request.activeProfile_)) throw PiPedalArgumentException("Choose Home, Studio or Live.");
    auto current=Get();if(request.expectedRevision_.empty() || current.revision_!=request.expectedRevision_) throw PiPedalStateException("Processing defaults changed; refresh before saving.");
    auto old=Read(serviceFile);Doc doc(nullptr,xmlFreeDoc);
    if(old) doc=Parse(*old);else {doc.reset(xmlNewDoc(BAD_CAST "1.0"));xmlDocSetRootElement(doc.get(),xmlNewNode(nullptr,BAD_CAST "PROPERTIES"));}
    ProfileData data;data.activeProfile_=request.activeProfile_;data.profiles_=current.profiles_;
    for(auto& profile:data.profiles_) if(profile.id_==request.activeProfile_) profile.defaults_=request.defaults_;
    SetProcessing(doc.get(),request.defaults_);Set(doc.get(),PROFILE_KEY,Json(data));
    xmlChar* memory=nullptr;int length=0;xmlDocDumpFormatMemoryEnc(doc.get(),&memory,&length,"UTF-8",1);
    if(!memory || length<=0) throw PiPedalStateException("Unable to serialize processing defaults.");
    Bytes bytes(memory,memory+length);xmlFree(memory);if(bytes.size()>MAX_XML) throw PiPedalArgumentException("Processing settings exceed the XML bound.");
    CheckPath(serviceFile);bool newDirectory=!fs::exists(serviceFile.parent_path());fs::create_directories(serviceFile.parent_path());CheckPath(serviceFile);
    if(newDirectory && chmod(serviceFile.parent_path().c_str(),0700)) throw PiPedalStateException("Unable to protect processing defaults directory.");
    struct stat prior{};if(old && lstat(serviceFile.c_str(),&prior)) throw PiPedalStateException("Processing defaults changed before publication.");
    if(old) Tone3000Library::BackupFile(dataRoot,serviceFile);
    std::string pattern=(serviceFile.parent_path()/".pipedal-defaults-XXXXXX").string();std::vector<char> name(pattern.begin(),pattern.end());name.push_back(0);
    int fd=mkstemp(name.data());if(fd<0) throw PiPedalStateException("Unable to stage processing defaults.");fs::path temp(name.data());
    try {
        if(old && (fchown(fd,prior.st_uid,prior.st_gid) || fchmod(fd,prior.st_mode&0777))) throw PiPedalStateException("Unable to preserve settings ownership/mode.");
        size_t done=0;while(done<bytes.size()) {ssize_t count=write(fd,bytes.data()+done,bytes.size()-done);if(count<0 && errno==EINTR) continue;if(count<=0) throw PiPedalStateException("Unable to write processing defaults.");done+=count;}
        if(fsync(fd)) throw PiPedalStateException("Unable to sync processing defaults.");close(fd);fd=-1;
        if(Get().revision_!=request.expectedRevision_) throw PiPedalStateException("Processing defaults changed before publication; refresh.");
        CheckPath(serviceFile);fs::rename(temp,serviceFile);
        int directory=open(serviceFile.parent_path().c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
        if(directory<0) throw PiPedalStateException("Defaults published; directory durability could not be verified.");int status=fsync(directory);close(directory);
        if(status) throw PiPedalStateException("Defaults published; directory durability could not be verified.");
    } catch(...) {if(fd>=0) close(fd);std::error_code ignored;fs::remove(temp,ignored);throw;}
    return Get();
} catch(const fs::filesystem_error&) {throw PiPedalStateException("Processing settings storage is unavailable; inspect the retained backup before retrying.");}
