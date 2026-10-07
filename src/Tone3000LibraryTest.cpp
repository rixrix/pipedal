// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#include "pch.h"
#include "catch.hpp"
#include "Tone3000Library.hpp"
#include "Tone3000Preset.hpp"
#include "Storage.hpp"
#include <bit>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <sys/stat.h>
#include <unistd.h>
using namespace pipedal;
namespace fs=std::filesystem;
namespace {
    using Bytes = std::vector<uint8_t>;
    using Fields = std::vector<std::pair<std::string, Bytes>>;

    // Independent fixtures encode the published JUCE stream contract. These
    // do not call the production reader/writer or require model DSP engines.
    void Append(Bytes &target, const Bytes &value) { target.insert(target.end(), value.begin(), value.end()); }
    Bytes TextBytes(const std::string &text)
    {
        Bytes result(text.begin(), text.end());
        result.push_back(0);
        return result;
    }
    Bytes Packed(uint32_t number)
    {
        Bytes result;
        while (number) { result.push_back(number & 255); number >>= 8; }
        result.insert(result.begin(), static_cast<uint8_t>(result.size()));
        return result;
    }
    Bytes Variant(uint8_t marker, Bytes payload = {})
    {
        Bytes result = Packed(static_cast<uint32_t>(payload.size() + 1));
        result.push_back(marker);
        Append(result, payload);
        return result;
    }
    Bytes StringValue(const std::string &value) { return Variant(5, TextBytes(value)); }
    Bytes DoubleBits(uint64_t bits)
    {
        Bytes payload;
        for (int i = 0; i < 8; ++i) { payload.push_back(bits & 255); bits >>= 8; }
        return Variant(4, payload);
    }
    Bytes DoubleValue(double value) { return DoubleBits(std::bit_cast<uint64_t>(value)); }
    Bytes IntValue(int32_t value)
    {
        Bytes payload;
        uint32_t bits = std::bit_cast<uint32_t>(value);
        for (int i = 0; i < 4; ++i) { payload.push_back(bits & 255); bits >>= 8; }
        return Variant(1, payload);
    }
    Bytes Node(const std::string &tag, const Fields &properties = {}, const std::vector<Bytes> &children = {})
    {
        Bytes result = TextBytes(tag);
        Append(result, Packed(static_cast<uint32_t>(properties.size())));
        for (const auto &[name, value] : properties)
        {
            Append(result, TextBytes(name));
            Append(result, value);
        }
        Append(result, Packed(static_cast<uint32_t>(children.size())));
        for (const auto &child : children) Append(result, child);
        return result;
    }

// Insert-only fixtures carry a valid full chain without inventing model payloads.
Bytes Fixture(const std::string& id="rig-1",const std::string& name="Rig one") {
    auto block=Node("ChainBlock",{{"id",StringValue("insert-1")},{"type",StringValue("insert")},{"enabled",Variant(2)}});
    auto snapshot=Node("ChainSnapshot",{}, {Node("ChainBlocks",{}, {block})});
    auto body=Node("T3KPreset",{{"schemaVersion",IntValue(1)},{"id",StringValue(id)},{"name",StringValue(name)}},
                   {snapshot,Node("Params")});
    auto header=Node("T3KPresetHeader",{{"id",StringValue(id)},{"name",StringValue(name)}});
    Bytes bytes{'T','3','K','H'};
    auto size=uint32_t(header.size());
    for(int i=0;i<4;++i) {bytes.push_back(size&255);size>>=8;}
    Append(bytes,header);Append(bytes,body);return bytes;
}
struct Temporary {
    fs::path path;
    Temporary() {
        auto pattern=(fs::canonical(fs::temp_directory_path())/"tone3000-library-test-XXXXXX").string();
        std::vector<char> chars(pattern.begin(),pattern.end());chars.push_back(0);
        auto result=mkdtemp(chars.data());
        if(!result) throw std::runtime_error("Unable to prepare fixture");
        path=result;
    }
    ~Temporary() {std::error_code ec;fs::remove_all(path,ec);}
};
void Put(const fs::path& path,const Bytes& bytes) {
    fs::create_directories(path.parent_path());
    std::ofstream stream(path,std::ios::binary);stream.write(reinterpret_cast<const char*>(bytes.data()),bytes.size());
    if(!stream) throw std::runtime_error("Unable to write fixture");
}
template<class T> std::string Json(const T& value) {std::ostringstream out;json_writer writer(out);writer.write(value);return out.str();}
Pedalboard Board() {
    Pedalboard board;board.name("Library rig");auto item=board.MakeEmptyItem();item.uri(Tone3000Preset::PLUGIN_URI);
    item.pluginName("TONE3000");board.items().push_back(item);
    Tone3000Library::ApplyState(board.items()[0],Tone3000Preset::BuildState(Fixture(),"rig.t3kpreset"),"app:fixture","hash-1");
    return board;
}
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-LIBRARY] [3.9] */
TEST_CASE("Tone3000 library rejects unsafe files and traverses execute-only ancestors","[gig_rig][gig_rig_library][Build]") {
    Temporary temp;
    REQUIRE(Tone3000Library::ValidFilename("My original rig.t3kpreset"));
    for(const auto& name:{"../rig.t3kpreset","a/b.t3kpreset",".rig.t3kpreset","rig.t3kpreset/","rig.t3kpreset\n","rig.zip"})
        REQUIRE_FALSE(Tone3000Library::ValidFilename(name));
    auto file=temp.path/"home/presets/rig.t3kpreset";auto bytes=Fixture();Put(file,bytes);
    REQUIRE(chmod((temp.path/"home").c_str(),0111)==0);
    REQUIRE(Tone3000Library::ReadFile(file)==bytes);
    REQUIRE(chmod((temp.path/"home").c_str(),0700)==0);
    REQUIRE_THROWS(Tone3000Library::ReadFile(file,bytes.size()-1));
    fs::create_symlink(file,temp.path/"linked.t3kpreset");
    REQUIRE_THROWS(Tone3000Library::ReadFile(temp.path/"linked.t3kpreset"));
    fs::create_directory_symlink(temp.path/"home",temp.path/"linked-home");
    REQUIRE_THROWS(Tone3000Library::ReadFile(temp.path/"linked-home/presets/rig.t3kpreset"));
    fs::create_hard_link(file,temp.path/"hard.t3kpreset");
    REQUIRE_THROWS(Tone3000Library::ReadFile(file));
    auto fifo=temp.path/"fifo.t3kpreset";REQUIRE(mkfifo(fifo.c_str(),0600)==0);
    REQUIRE_THROWS(Tone3000Library::ReadFile(fifo));
    Put(temp.path/"not-a-directory",Bytes{1});
    try {
        Tone3000Library::ReadFile(temp.path/"not-a-directory/child.t3kpreset");
        FAIL("Invalid ancestor accepted");
    } catch(const std::exception& error) {
        REQUIRE(std::string(error.what()).find(temp.path.string())==std::string::npos);
    }
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-SEC] [3.9] */
TEST_CASE("Tone3000 discovery deduplicates versions and guards source changes","[gig_rig][gig_rig_library][Build]") {
    Temporary temp;auto app=temp.path/"app",service=temp.path/"service";
    Put(app/"original.t3kpreset",Fixture());Put(service/"copy.t3kpreset",Fixture());
    Tone3000Library library(temp.path, std::vector<Tone3000Library::Root>{{app,"app","Pi app","user"},{service,"service","Service","user"}});
    std::vector<std::string> warnings;auto sources=library.Scan(&warnings);
    REQUIRE(warnings.empty());REQUIRE(sources.size()==1);REQUIRE(sources[0].entry.source_=="Pi app");
    REQUIRE(sources[0].aliases.size()==1);
    REQUIRE(library.Resolve(sources[0].aliases[0],sources[0].entry.sha256_).entry.key_==sources[0].entry.key_);
    auto key=sources[0].entry.key_,hash=sources[0].entry.sha256_;
    fs::rename(app/"original.t3kpreset",app/"renamed.t3kpreset");
    REQUIRE(library.Resolve(key,hash).path.filename()=="renamed.t3kpreset");
    Put(app/"renamed.t3kpreset",Fixture("rig-1","Changed rig"));
    REQUIRE_THROWS(library.Resolve(key,hash));REQUIRE(library.Scan(nullptr).size()==2);
    Put(app/"conflicting.t3kpreset",Fixture("rig-1","Third version"));
    warnings.clear();sources=library.Scan(&warnings);
    REQUIRE(sources.size()==1);REQUIRE(sources[0].entry.source_=="Service");REQUIRE_FALSE(warnings.empty());
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-SEC] [3.9] */
TEST_CASE("Tone3000 upload validates before publishing and retains exact previous bytes","[gig_rig][gig_rig_library][Build]") {
    Temporary temp;auto uploads=temp.path/"tone3000-library/uploads",incoming=temp.path/"incoming";
    Tone3000Library library(temp.path,std::vector<Tone3000Library::Root>{{uploads,"uploaded","Uploaded","user"}});
    Put(incoming,Bytes{1,2,3});REQUIRE_THROWS(library.Upload("rig.t3kpreset",incoming));
    REQUIRE_FALSE(fs::exists(uploads));
    auto original=Fixture();Put(incoming,original);auto first=library.Upload("rig.t3kpreset",incoming);
    REQUIRE(Tone3000Library::ReadFile(uploads/"rig.t3kpreset")==original);
    REQUIRE(library.Upload("duplicate.t3kpreset",incoming).key_==first.key_);
    REQUIRE_FALSE(fs::exists(uploads/"duplicate.t3kpreset"));
    auto changed=Fixture("rig-1","Updated rig");Put(incoming,changed);auto second=library.Upload("rig.t3kpreset",incoming);
    REQUIRE(second.key_==first.key_);REQUIRE(second.sha256_!=first.sha256_);
    bool retained=false,hashRetained=false;
    for(auto& file:fs::directory_iterator(temp.path/"tone3000-library/backups")) {
        auto bytes=Tone3000Library::ReadFile(file.path());
        if(file.path().extension()==".sha256") hashRetained=std::string(bytes.begin(),bytes.end())==first.sha256_;
        else retained=bytes==original;
    }
    REQUIRE(retained);REQUIRE(hashRetained);
    Put(incoming,Fixture("rig-1","Conflicting name"));
    REQUIRE_THROWS(library.Upload("other.t3kpreset",incoming));
    REQUIRE(Tone3000Library::ReadFile(uploads/"rig.t3kpreset")==changed);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
TEST_CASE("Tone3000 imported state retains board identities effects and snapshots","[gig_rig][gig_rig_library][Build]") {
    auto board=Board();auto& item=board.items()[0];auto id=item.instanceId();item.title("User title");item.isEnabled(false);
    item.lilvPresetUri("old:program");item.pathProperties({{"numeric-cache","cached"}});
    auto snapshot=std::make_shared<Snapshot>();snapshot->name_="Saved override";
    SnapshotValue value;value.instanceId_=id;value.lv2State_=item.lv2State();snapshot->values_.push_back(value);board.snapshots().push_back(snapshot);
    auto snapshots=Json(board.snapshots());
    auto effect=board.MakeEmptyItem();effect.uri("test:delay");effect.controlValues().push_back(ControlValue("mix",.2f));board.items().push_back(effect);
    auto effectJson=Json(board.items()[1]);
    Tone3000Library::ApplyState(board.items()[0],Tone3000Preset::BuildState(Fixture("rig-2","New rig"),"new.t3kpreset"),"app:new","hash-2");
    REQUIRE(board.items()[0].instanceId()==id);REQUIRE(board.items()[0].title()=="User title");REQUIRE_FALSE(board.items()[0].isEnabled());
    REQUIRE(board.items()[0].lilvPresetUri().empty());REQUIRE(board.items()[0].pathProperties().empty());
    REQUIRE(Json(board.items()[1])==effectJson);REQUIRE(Json(board.snapshots())==snapshots);
    REQUIRE(Tone3000Library::HasSnapshotOverrides(board,id));
    std::istringstream in(Json(board));json_reader reader(in);Pedalboard restored;reader.read(&restored);
    REQUIRE(restored.items()[0].tone3000SourceKey()=="app:new");REQUIRE(restored.items()[0].tone3000SourceHash()=="hash-2");
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
TEST_CASE("Tone3000 storage appends and updates without selecting or changing stock","[gig_rig][gig_rig_library][Build]") {
    Temporary temp;fs::create_directories(temp.path/"presets");Storage storage;storage.SetDataRoot(temp.path);
    storage.CreateBank("Factory Presets");auto stockId=storage.GetBanks().entries()[0].instanceId();storage.LoadBank(stockId);
    auto selectedPreset=storage.GetCurrentPresetId();BankFile stock;storage.GetBankFile(stockId,&stock);auto stockJson=Json(stock);
    fs::path stockPath;
    for(const auto& file:fs::directory_iterator(temp.path/"presets")) if(file.path().extension()==".bank") stockPath=file.path();
    REQUIRE_FALSE(stockPath.empty());auto stockBytes=Tone3000Library::ReadFile(stockPath);
    auto board=Board();auto id=board.items()[0].instanceId();auto first=storage.SaveTone3000Preset(-1,-1,board,id);
    REQUIRE(storage.GetBanks().entries().size()==2);REQUIRE(storage.GetBanks().entries().back().instanceId()==first.bankId_);
    REQUIRE(storage.GetBanks().selectedBank()==stockId);REQUIRE(storage.GetCurrentPresetId()==selectedPreset);
    auto second=storage.SaveTone3000Preset(first.bankId_,-1,board,id);
    REQUIRE(second.presetId_!=first.presetId_);REQUIRE(board.name()=="Library rig (2)");
    BankFile bank;storage.GetBankFile(first.bankId_,&bank);auto firstJson=Json(bank.getItem(first.presetId_));
    auto updated=bank.getItem(second.presetId_).preset().DeepCopy();updated.items()[0].title("Keep title");
    auto effect=updated.MakeEmptyItem();effect.uri("test:delay");updated.items().push_back(effect);auto effectJson=Json(updated.items()[1]);
    auto result=storage.SaveTone3000Preset(first.bankId_,second.presetId_,updated,id);
    REQUIRE(result.presetId_==second.presetId_);storage.GetBankFile(first.bankId_,&bank);
    REQUIRE(Json(bank.getItem(first.presetId_))==firstJson);REQUIRE(Json(bank.getItem(second.presetId_).preset().items()[1])==effectJson);
    REQUIRE(bank.presets()[0]->instanceId()==first.presetId_);REQUIRE(bank.presets()[1]->instanceId()==second.presetId_);
    REQUIRE(storage.GetBanks().selectedBank()==stockId);REQUIRE(storage.GetCurrentPresetId()==selectedPreset);
    REQUIRE_THROWS(storage.SaveTone3000Preset(stockId,selectedPreset,updated,id));
    storage.GetBankFile(stockId,&stock);REQUIRE(Json(stock)==stockJson);
    REQUIRE(Tone3000Library::ReadFile(stockPath)==stockBytes);
    storage.LoadBank(first.bankId_);REQUIRE(storage.LoadPreset(second.presetId_));
    updated.items()[0].title("Reload same ID");storage.SaveTone3000Preset(first.bankId_,second.presetId_,updated,id);
    REQUIRE(storage.LoadPreset(second.presetId_));REQUIRE(storage.GetCurrentPreset().items()[0].title()=="Reload same ID");
}
