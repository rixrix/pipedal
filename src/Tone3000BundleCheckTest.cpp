// SPDX-License-Identifier: MIT
#include "catch.hpp"
#include "Tone3000BundleCheck.hpp"
#include "Tone3000Library.hpp"
#include "Banks.hpp"
#include "zip.h"
#include <fstream>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>
using namespace pipedal;
namespace fs=std::filesystem;
namespace {
using Bytes=std::vector<uint8_t>;
Bytes Text(const std::string& s){Bytes result(s.begin(),s.end());result.push_back(0);return result;}
Bytes Packed(uint32_t v){Bytes out;while(v){out.push_back(v&255);v>>=8;}out.insert(out.begin(),out.size());return out;}
void Append(Bytes& a,const Bytes& b){a.insert(a.end(),b.begin(),b.end());}
Bytes Var(uint8_t type,const Bytes& value){auto out=Packed(value.size()+1);out.push_back(type);Append(out,value);return out;}
Bytes Node(const std::string& tag,const std::vector<std::pair<std::string,Bytes>>& fields={},const std::vector<Bytes>& children={}){
    auto out=Text(tag);Append(out,Packed(fields.size()));for(const auto& [key,value]:fields){Append(out,Text(key));Append(out,value);}Append(out,Packed(children.size()));for(const auto& child:children)Append(out,child);return out;
}
Lv2PluginState State(){
    const auto str=[](const std::string& s){return Var(5,Text(s));};
    const auto cached=Node("CachedModel",{{"modelId",Var(1,{1,0,0,0})},{"data",Var(8,{8,9,10})}});
    const auto block=Node("ChainBlock",{{"id",str("amp")},{"type",str("nam")},{"activeModelId",Var(1,{1,0,0,0})},{"toneJson",str("{}")}}, {Node("ModelCache",{}, {cached})});
    auto bytes=Bytes{'T','3','K','B'};Append(bytes,Node("T3KPreset",{{"schemaVersion",Var(1,{1,0,0,0})},{"id",str("fixture")},{"name",str("Fixture")}}, {Node("ChainSnapshot",{}, {Node("ChainBlocks",{}, {block})}),Node("Params")}));
    return Tone3000Preset::BuildState(bytes,"fixture.t3kpreset");
}
std::string Bank(bool path=false,bool reference=false){
    BankFile bank;bank.name("Bundle fixture");Pedalboard board;board.name("Tone");auto item=board.MakeEmptyItem();item.uri(Tone3000Preset::PLUGIN_URI);item.pluginName("TONE3000");
    if(!reference)item.lv2State(State());else item.lilvPresetUri("https://www.tone3000.com/plugin:preset1");
    if(path){auto value=item.lv2State();auto& entry=value.values_["fixture:media"];entry.atomType_="http://lv2plug.in/ns/ext/atom#Path";entry.value_=Text("cab.wav");entry.flags_=3;item.lv2State(value);}
    board.items().push_back(item);bank.selectedPreset(bank.addPreset(board));std::ostringstream out;json_writer writer(out);writer.write(bank);return out.str();
}
struct Temp{fs::path path;Temp(){char n[]="/tmp/tone3000-bundle-XXXXXX";auto r=mkdtemp(n);if(!r)throw std::runtime_error("temp");path=fs::canonical(r);}~Temp(){std::error_code ec;fs::remove_all(path,ec);}};
void Put(const fs::path& path,const std::string& text){std::ofstream stream(path,std::ios::binary);stream<<text;}
void Archive(const fs::path& path,const std::map<std::string,std::string>& files,bool link=false){
    int error=0;auto zip=zip_open(path.c_str(),ZIP_CREATE|ZIP_TRUNCATE,&error);REQUIRE(zip);
    for(const auto& [name,text]:files){auto source=zip_source_buffer(zip,text.data(),text.size(),0);REQUIRE(source);const auto index=zip_file_add(zip,name.c_str(),source,0);REQUIRE(index>=0);if(link)REQUIRE(zip_file_set_external_attributes(zip,index,0,ZIP_OPSYS_UNIX,(S_IFLNK|0777)<<16)==0);}
    REQUIRE(zip_close(zip)==0);
}
const Tone3000BundleCheck::Resolver Installed=[](const std::string& uri)->std::optional<Tone3000BundlePluginVersion>{if(uri==Tone3000Preset::PLUGIN_URI)return Tone3000BundlePluginVersion{"TONE3000",1,2};return {};};
}
/** Full-state assets and version metadata are independent of engine readiness.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BUNDLE] [7.7]
 */
TEST_CASE("Portable bundle checker identifies assets versions and missing dependencies", "[gig_rig][Build]"){
    Temp temp;auto file=temp.path/"rig.piBank";
    Archive(file,{{"bankFile.json",Bank(true)},{"pluginsUsed.json","[{\"uri\":\"https://www.tone3000.com/plugin\",\"minorVersion\":\"1\",\"microVersion\":\"2\"}]"}});
    auto report=Tone3000BundleCheck::Check(file,Installed);REQUIRE(report.missingMedia_==std::vector<std::string>{"cab.wav"});REQUIRE_FALSE(report.knownAssetsPresent_);REQUIRE(report.namCount_==1);REQUIRE(report.embeddedBytes_==3);REQUIRE(report.plugins_.front().versionStatus_=="match");REQUIRE_FALSE(report.readinessProven_);
    Archive(file,{{"bankFile.json",Bank(true)},{"media/cab.wav","fixture media bytes"},{"pluginsUsed.json","[{\"uri\":\"https://www.tone3000.com/plugin\",\"minorVersion\":1,\"microVersion\":3}]"}});
    report=Tone3000BundleCheck::Check(file,Installed);REQUIRE(report.knownAssetsPresent_);REQUIRE(report.completenessKnown_);REQUIRE(report.plugins_.front().versionStatus_=="mismatch");
    report=Tone3000BundleCheck::Check(file,[](const std::string&)->std::optional<Tone3000BundlePluginVersion>{return {};});REQUIRE_FALSE(report.plugins_.front().installed_);REQUIRE(report.plugins_.front().versionStatus_=="missing");
    Archive(file,{{"bankFile.json",Bank(true)},{"media/cab.wav",""}});report=Tone3000BundleCheck::Check(file,Installed);REQUIRE_FALSE(report.knownAssetsPresent_);REQUIRE(report.missingMedia_==std::vector<std::string>{"cab.wav"});
    Put(temp.path/"legacy.piPreset",Bank(false,true));report=Tone3000BundleCheck::Check(temp.path/"legacy.piPreset",Installed);REQUIRE(report.incompleteToneStates_==1);REQUIRE_FALSE(report.completenessKnown_);REQUIRE(report.plugins_.front().versionStatus_=="unknown");
}
/** Every entry is inspected without writing media or saved banks.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BUNDLE] [DES-SEC] [7.7]
 */
TEST_CASE("Portable bundle checker refuses unsafe archives and oversized malformed input", "[gig_rig][Build]"){
    Temp temp;auto file=temp.path/"rig.piBank";
    for(const auto& name:{"../secret","/secret","media/../secret","media//secret","C:/secret","media\\secret"})REQUIRE_FALSE(Tone3000BundleCheck::SafeEntry(name));
    REQUIRE(Tone3000BundleCheck::SafeEntry("media/cabs/IR.wav"));
    Archive(file,{{"bankFile.json",Bank()},{"../secret","private"}});REQUIRE_THROWS(Tone3000BundleCheck::Check(file,Installed));
    Archive(file,{{"bankFile.json",Bank()}},true);REQUIRE_THROWS(Tone3000BundleCheck::Check(file,Installed));
    Put(file,"{}");REQUIRE_THROWS(Tone3000BundleCheck::Check(file,Installed));
    Put(file,"{\"name\":\"Malformed\",\"presets\":[null]}");REQUIRE_THROWS(Tone3000BundleCheck::Check(file,Installed));
    auto nonfinite=Bank();const auto volume=nonfinite.find("\"input_volume_db\":");REQUIRE(volume!=std::string::npos);
    const auto start=volume+std::string("\"input_volume_db\":").size(),end=nonfinite.find_first_of(",}",start);
    nonfinite.replace(start,end-start,"NaN");Put(file,nonfinite);REQUIRE_THROWS(Tone3000BundleCheck::Check(file,Installed));
    Put(file,std::string(129,'[')+std::string(129,']'));REQUIRE_THROWS(Tone3000BundleCheck::Check(file,Installed));
    {std::ofstream sparse(file,std::ios::binary);sparse.seekp(Tone3000BundleCheck::MAX_FILE);sparse.put('x');}REQUIRE_THROWS(Tone3000BundleCheck::Check(file,Installed));
    REQUIRE_FALSE(fs::exists(temp.path/"media"));REQUIRE_FALSE(fs::exists(temp.path/"tone3000-library"));
}
