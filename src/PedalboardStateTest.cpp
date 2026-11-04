// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT

#include "pch.h"
#include "catch.hpp"
#include "Pedalboard.hpp"
#include "PluginHost.hpp"
#include "lv2/lv2plug.in/ns/ext/buf-size/buf-size.h"
#include <cstring>

using namespace pipedal;

namespace
{
    Pedalboard MakeStateBoard()
    {
        Pedalboard board;
        PedalboardItem item = board.MakeEmptyItem();
        item.uri("urn:pipedal:test:stateful-plugin");
        item.controlValues().push_back(ControlValue("gain", 0.5f));
        item.lv2State().isValid_ = true;
        auto &entry = item.lv2State().values_["urn:pipedal:test:rig"];
        entry.atomType_ = "http://lv2plug.in/ns/ext/atom#String";
        entry.value_ = {'A', 0};
        board.items().push_back(item);
        return board;
    }

    void RequireRebuild(const Pedalboard &oldBoard, const Pedalboard &newBoard)
    {
        REQUIRE_FALSE(oldBoard.IsStructureIdentical(newBoard));
        REQUIRE_FALSE(newBoard.IsStructureIdentical(oldBoard));
    }
}

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-1] [DES-COMPAT] [1.7]
 */
TEST_CASE("Host exposes a stable bounded-block instantiate feature", "[gig_rig][Build]")
{
    PluginHost host;
    const LV2_Feature *bounded = nullptr;
    size_t count = 0;
    for (auto feature = host.asIHost()->GetLv2Features(); *feature != nullptr; ++feature)
    {
        if (std::strcmp((*feature)->URI, LV2_BUF_SIZE__boundedBlockLength) == 0)
        {
            bounded = *feature;
            ++count;
        }
        REQUIRE(std::strcmp((*feature)->URI, LV2_BUF_SIZE__fixedBlockLength) != 0);
    }
    REQUIRE(count == 1);
    REQUIRE(bounded != nullptr);
    REQUIRE(bounded->data == nullptr);

    // An effect keeps the feature pointers copied from this null-terminated list.
    std::vector<const LV2_Feature *> instantiateFeatures;
    for (auto feature = host.asIHost()->GetLv2Features(); *feature != nullptr; ++feature)
    {
        instantiateFeatures.push_back(*feature);
    }
    instantiateFeatures.push_back(nullptr);
    host.SetPluginStoragePath("/tmp/pipedal-state-feature-test");
    REQUIRE(std::strcmp(bounded->URI, LV2_BUF_SIZE__boundedBlockLength) == 0);
    REQUIRE(instantiateFeatures[instantiateFeatures.size() - 2] == bounded);
    REQUIRE(instantiateFeatures.back() == nullptr);
}

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-3] [DES-RELOAD] [1.8]
 */
TEST_CASE("Changed plugin state forces a real pedalboard reload", "[gig_rig][Build]")
{
    Pedalboard oldBoard = MakeStateBoard();
    Pedalboard newBoard = oldBoard;
    REQUIRE(oldBoard.IsStructureIdentical(newBoard));

    SECTION("Opaque rig bytes change even when update counters match")
    {
        newBoard.items()[0].lv2State().values_.begin()->second.value_[0] = 'B';
        REQUIRE(oldBoard.items()[0].stateUpdateCount() == newBoard.items()[0].stateUpdateCount());
    }
    SECTION("Opaque state type changes")
    {
        newBoard.items()[0].lv2State().values_.begin()->second.atomType_ = "urn:test:different-type";
    }
    SECTION("State validity changes")
    {
        newBoard.items()[0].lv2State().isValid_ = false;
    }
    SECTION("Pending factory preset import")
    {
        newBoard.items()[0].lilvPresetUri("urn:test:preset:2");
    }
    SECTION("A different pending factory preset")
    {
        oldBoard.items()[0].lilvPresetUri("urn:test:preset:1");
        newBoard.items()[0].lilvPresetUri("urn:test:preset:2");
    }
    SECTION("VST state changes")
    {
        newBoard.items()[0].vstState("new opaque state");
    }
    SECTION("A path property is added")
    {
        newBoard.items()[0].pathProperties_["urn:test:ir"] = "\"new.wav\"";
    }
    SECTION("A path property changes")
    {
        oldBoard.items()[0].pathProperties_["urn:test:ir"] = "\"old.wav\"";
        newBoard.items()[0].pathProperties_["urn:test:ir"] = "\"new.wav\"";
    }
    RequireRebuild(oldBoard, newBoard);
}

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RELOAD] [1.8]
 */
TEST_CASE("Control-only changes retain the snapshot shortcut", "[gig_rig][Build]")
{
    Pedalboard oldBoard = MakeStateBoard();
    Pedalboard newBoard = oldBoard;
    newBoard.items()[0].SetControlValue("gain", 0.9f);
    newBoard.items()[0].isEnabled(false);
    newBoard.items()[0].stateUpdateCount(42);
    newBoard.name("Another song");
    newBoard.input_volume_db(-6);
    newBoard.output_volume_db(-3);
    REQUIRE(oldBoard.IsStructureIdentical(newBoard));
    REQUIRE(newBoard.IsStructureIdentical(oldBoard));
}

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-2] [FR-3] [DES-RELOAD] [1.8]
 */
TEST_CASE("Every nested Split branch participates in state comparison", "[gig_rig][Build]")
{
    Pedalboard oldBoard;
    auto outer = oldBoard.MakeSplit();
    auto inner = oldBoard.MakeSplit();
    inner.topChain()[0] = MakeStateBoard().items()[0];
    inner.bottomChain()[0] = MakeStateBoard().items()[0];
    inner.topChain()[0].instanceId(100);
    inner.bottomChain()[0].instanceId(101);
    outer.topChain()[0] = inner;
    outer.bottomChain()[0] = inner;
    outer.bottomChain()[0].instanceId(102);
    outer.bottomChain()[0].topChain()[0].instanceId(103);
    outer.bottomChain()[0].bottomChain()[0].instanceId(104);
    oldBoard.items().push_back(outer);
    Pedalboard newBoard = oldBoard;
    REQUIRE(oldBoard.IsStructureIdentical(newBoard));

    SECTION("Top within top")
    {
        newBoard.items()[0].topChain()[0].topChain()[0].lilvPresetUri("urn:test:rig:2");
    }
    SECTION("Bottom within top")
    {
        newBoard.items()[0].topChain()[0].bottomChain()[0].vstState("changed");
    }
    SECTION("Top within bottom")
    {
        newBoard.items()[0].bottomChain()[0].topChain()[0].pathProperties_["urn:test:ir"] = "null";
    }
    SECTION("Bottom within bottom")
    {
        newBoard.items()[0].bottomChain()[0].bottomChain()[0].lv2State().values_.begin()->second.value_[0] = 'B';
    }
    RequireRebuild(oldBoard, newBoard);
}

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RELOAD] [1.8]
 */
TEST_CASE("Split branch length and plugin structure changes require reload", "[gig_rig][Build]")
{
    Pedalboard oldBoard;
    oldBoard.items().push_back(oldBoard.MakeSplit());
    Pedalboard newBoard = oldBoard;
    SECTION("Shorter bottom chain")
    {
        newBoard.items()[0].bottomChain().clear();
    }
    SECTION("Longer bottom chain")
    {
        newBoard.items()[0].bottomChain().push_back(newBoard.items()[0].bottomChain()[0]);
    }
    SECTION("Shorter top chain")
    {
        newBoard.items()[0].topChain().clear();
    }
    SECTION("Different bottom plugin URI")
    {
        newBoard.items()[0].bottomChain()[0].uri("urn:test:other-plugin");
    }
    SECTION("Different bottom instance ID")
    {
        newBoard.items()[0].bottomChain()[0].instanceId(999);
    }
    SECTION("Different Split type")
    {
        newBoard.items()[0].SetControlValue(SPLIT_SPLITTYPE_KEY, 1);
    }
    RequireRebuild(oldBoard, newBoard);
}

/**
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-5] [DES-RELOAD] [1.8]
 */
TEST_CASE("Split selection retains the snapshot shortcut", "[gig_rig][Build]")
{
    Pedalboard oldBoard;
    oldBoard.items().push_back(oldBoard.MakeSplit());
    Pedalboard newBoard = oldBoard;
    newBoard.items()[0].SetControlValue(SPLIT_SELECT_KEY, 1);
    REQUIRE(oldBoard.IsStructureIdentical(newBoard));
}
