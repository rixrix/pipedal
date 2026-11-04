// SPDX-License-Identifier: MIT
#include "catch.hpp"
#include "Tone3000Performance.hpp"
#include "Tone3000Library.hpp"
#include <fstream>
#include <sstream>
#include <unistd.h>
using namespace pipedal;
namespace fs=std::filesystem;
namespace {
std::string Text(const fs::path& path){std::ifstream stream(path);return {std::istreambuf_iterator<char>(stream),{}};}
struct Temp{fs::path path;Temp(){char name[]="/tmp/tone3000-performance-XXXXXX";auto result=mkdtemp(name);if(!result)throw std::runtime_error("temp");path=fs::canonical(result);}~Temp(){std::error_code ec;fs::remove_all(path,ec);}};
std::vector<Pedalboard> Boards(){std::vector<Pedalboard> result;for(int i=0;i<4;++i){Pedalboard board;board.name("Rig "+std::to_string(3-i));auto item=board.MakeEmptyItem();item.uri("test:effect");item.controlValues().emplace_back("gain",.2f+i*.1f);item.tone3000SourceKey("mapped-source");item.tone3000SourceHash("saved-source-hash");board.items().push_back(item);auto snapshot=std::make_shared<Snapshot>();snapshot->name_="Saved version";board.snapshots().push_back(snapshot);result.push_back(board);}return result;}
}
/** No source-order sorting, state regeneration or shared mutable snapshots.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BANK] [7.4]
 */
TEST_CASE("Performance copies preserve complete boards in requested order", "[gig_rig][Build]"){
    auto sources=Boards();const auto before=Tone3000Performance::Revision(sources.front());
    auto bank=Tone3000Performance::Prepare("Test",sources);const auto result=Tone3000Performance::Result(42,bank);
    REQUIRE(result.slots_.size()==4);REQUIRE(result.bankId_==42);REQUIRE(result.slots_.front().name_=="A - Rig 3");
    for(size_t i=0;i<4;++i){auto copy=bank.presets()[i]->preset();copy.name(sources[i].name());REQUIRE(Tone3000Performance::Revision(copy)==Tone3000Performance::Revision(sources[i]));REQUIRE(result.slots_[i].program_==i);REQUIRE(result.slots_[i].presetId_==i+1);}
    bank.presets().front()->preset().snapshots().front()->name_="Changed copy";
    REQUIRE(sources.front().snapshots().front()->name_=="Saved version");REQUIRE(Tone3000Performance::Revision(sources.front())==before);
}
/** Validate all identities/revisions before filesystem publication.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BANK] [DES-SEC] [7.4]
 */
TEST_CASE("Performance creation rejects partial duplicate and malformed requests", "[gig_rig][Build]"){
    Tone3000PerformanceRequest request;request.name_="Gig";for(int i=0;i<4;++i)request.slots_.push_back({6,i,std::string(64,'a')});
    REQUIRE_NOTHROW(Tone3000Performance::Validate(request));request.slots_[3]=request.slots_[0];REQUIRE_THROWS(Tone3000Performance::Validate(request));
    request.slots_[3].presetId_=3;request.slots_[2].expectedRevision_="stale";REQUIRE_THROWS(Tone3000Performance::Validate(request));
    request.slots_[2].expectedRevision_=std::string(64,'a');request.name_="../bank";REQUIRE_THROWS(Tone3000Performance::Validate(request));
    auto parse=[](const std::string& text){std::istringstream stream(text);json_reader reader(stream);json_variant value;reader.read(&value);return value;};
    for(const auto& text:{"{\"handle\":1.5}","{\"handle\":0}","{\"handle\":\"1\"}","{\"handle\":1,\"other\":true}"})REQUIRE_THROWS(Tone3000Performance::ProgramListenerHandle(parse(text)));
    REQUIRE(Tone3000Performance::ProgramListenerHandle(parse("{\"handle\":2}"))==2);
}
/** New bank publication preserves original index selection and refuses links/collisions.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BANK] [DES-SEC] [7.4]
 */
TEST_CASE("Performance publication preserves selection and existing destinations", "[gig_rig][Build]"){
    Temp temp;const auto indexPath=temp.path/"index.json",bankPath=temp.path/"performance.bank";
    BankIndex original;const auto old=original.addBank(-1,"TONE3000 Original");original.selectedBank(old);
    {std::ofstream file(indexPath);json_writer writer(file);writer.write(original);}
    const auto before=Text(indexPath);auto next=original;next.addBank(old,"TONE3000 Performance - Gig");auto bank=Tone3000Performance::Prepare("Gig",Boards());
    Tone3000Performance::Publish(temp.path,bankPath,indexPath,bank,next);
    REQUIRE(fs::exists(bankPath));REQUIRE(next.selectedBank()==old);REQUIRE(original.entries().size()==1);
    BankIndex saved;{std::ifstream stream(indexPath);json_reader reader(stream);reader.read(&saved);}REQUIRE(saved.selectedBank()==old);REQUIRE(saved.entries().size()==2);
    const auto publishedBank=Text(bankPath),publishedIndex=Text(indexPath);
    REQUIRE_THROWS(Tone3000Performance::Publish(temp.path,bankPath,indexPath,bank,next));REQUIRE(Text(bankPath)==publishedBank);REQUIRE(Text(indexPath)==publishedIndex);
    const auto linked=temp.path/"linked.bank";fs::create_symlink(bankPath,linked);REQUIRE_THROWS(Tone3000Performance::Publish(temp.path,linked,indexPath,bank,next));REQUIRE(Text(indexPath)==publishedIndex);
    bool retained=false;for(const auto& file:fs::directory_iterator(temp.path/"tone3000-library/backups"))if(file.path().extension()!=".sha256"&&Text(file.path())==before)retained=true;REQUIRE(retained);
}
