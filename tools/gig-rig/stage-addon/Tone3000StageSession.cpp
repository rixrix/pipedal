// Copyright (c) 2026 PiPedal contributors
// SPDX-License-Identifier: MIT
#include "Tone3000StageSession.h"
#include "Processor.h"
#include "NAM/slimmable.h"
#include <cmath>
#include <cstring>
#include <limits>

namespace {
juce::DynamicObject::Ptr object() {return new juce::DynamicObject();}
bool number(const juce::var& value) {return value.isDouble()||value.isInt()||value.isInt64();}
bool doneState(const juce::String& state) {return state=="done"||state=="timeout"||state=="cancelled"||state=="notApplicable"||state=="failed";}
void finiteField(juce::DynamicObject& obj,const char* name,double value) {
    obj.setProperty(name,std::isfinite(value)?juce::var(value):juce::var());
}
}

Tone3000StageSession::Tone3000StageSession(TONE3000Processor& processor):owner(&processor) {
    for(auto* parameter:static_cast<juce::AudioProcessor&>(processor).getParameters())
        if(auto* identified=dynamic_cast<juce::AudioProcessorParameterWithID*>(parameter)) {
            parameterIds.push_back(identified->paramID);
            processor.parameters.addParameterListener(identified->paramID,this);
        }
}
Tone3000StageSession::~Tone3000StageSession(){stopTimer();}

void Tone3000StageSession::parameterChanged(const juce::String& id,float) {
    // Only our known completion gestures, on the message thread, are exempt.
    const bool output=id=="outputBalance"||id=="alignOffset"||id=="alignEnabled"||id=="chainInvertRight";
    auto* manager=juce::MessageManager::getInstanceWithoutCreating();
    if(output&&ownCompletionWrites.load(std::memory_order_relaxed)&&manager&&manager->isThisTheMessageThread())return;
    parameterRevision.fetch_add(1,std::memory_order_relaxed);
}

int32_t Tone3000StageSession::submit(uint64_t requested,uint32_t operation,const char* payload,uint32_t bytes) {
    if(!requested||bytes>TONE3000_STAGE_MAX_REQUEST||(!payload&&bytes)||operation<1||operation>7)
        return TONE3000_STAGE_INVALID;
    if(bytes&&std::memchr(payload,0,bytes))return TONE3000_STAGE_INVALID;
    std::lock_guard lock(mutex);
    if(!owner)return TONE3000_STAGE_CLOSED;
    if(operation==TONE3000_STAGE_CANCEL) {
        if(bytes)return TONE3000_STAGE_INVALID;
        if(requested!=token)return TONE3000_STAGE_STALE;
        // Retain a completed mutation until the host captures its real state.
        // @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5]
        if(!active)return 0;
        cancelRequested=true;result.clear();
    } else {
        if(active)return TONE3000_STAGE_BUSY;
        if(requested==token)return TONE3000_STAGE_STALE;
        token=requested;command=operation;active=true;cancelRequested=false;result.clear();
    }
    auto weak=weak_from_this();auto text=juce::String::fromUTF8(payload?payload:"",(int)bytes);
    if(!juce::MessageManager::callAsync([weak,requested,operation,text] {
        if(auto session=weak.lock())session->begin(requested,operation,text);
    })) {active=false;return TONE3000_STAGE_CLOSED;}
    return 0;
}

int32_t Tone3000StageSession::read(uint64_t requested,char* output,uint32_t capacity) {
    std::lock_guard lock(mutex);
    if(!owner)return TONE3000_STAGE_CLOSED;
    if(!requested||requested!=token)return TONE3000_STAGE_STALE;
    if(result.empty())return 0;
    if(!output||capacity<result.size()+1)return TONE3000_STAGE_CAPACITY;
    std::memcpy(output,result.c_str(),result.size()+1);return (int32_t)result.size()+1;
}

void Tone3000StageSession::shutdown() {
    auto retained=shared_from_this();
    bool timerAlive=false;
    {
        std::lock_guard lock(mutex);
        if(!owner)return;
        cancelNative();
        for(const auto& id:parameterIds)owner->parameters.removeParameterListener(id,this);
        timerAlive=timerLifetime!=nullptr;
        owner=nullptr;active=false;
        // The local/queued cleanup capture now owns the timer lifetime. A queued
        // callback can be discarded when the last Linux LV2 message thread stops;
        // retaining a self-reference until that callback would leak the session.
        // @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5]
        timerLifetime.reset();
    }
    if(!timerAlive){stopTimer();return;}
    // Timer lifetime ends on its message thread; queued callbacks retain no processor.
    if(!juce::MessageManager::callAsync([retained]{retained->stopTimer();}))retained->stopTimer();
}

void Tone3000StageSession::cancelNative() {
    juce::ScopedLock callback(owner->getCallbackLock());
    owner->cancelAutoBalance();owner->cancelAutoOffset();meter.cancel();
}
void Tone3000StageSession::publish(juce::DynamicObject::Ptr value) {
    value->setProperty("command",(int)command);
    try {value->setProperty("runtime",runtime());}
    catch(const std::exception&) {auto unknown=object();unknown->setProperty("unknown",true);value->setProperty("runtime",juce::var(unknown.get()));}
    auto json=juce::JSON::toString(juce::var(value.get()),true).toStdString();
    if(json.size()+1>TONE3000_STAGE_MAX_RESPONSE)json="{\"state\":\"failed\",\"error\":\"Runtime result capacity exceeded\"}";
    result=std::move(json);
}
void Tone3000StageSession::finish(const juce::String& state) {
    auto value=object();value->setProperty("state",state);publish(value);
    active=false;stopTimer();timerLifetime.reset();
}
juce::var Tone3000StageSession::runtime(){return owner->getStageRuntime();}
bool Tone3000StageSession::liveStereo(const juce::var& state) const {
    if(!(bool)state["stereoEnabled"]||!(bool)state["audioActive"]||(bool)state["truncated"]||owner->isNonRealtime())return false;
    bool left=false,right=false;
    auto* blocks=state["blocks"].getArray();if(!blocks)return false;
    for(const auto& block:*blocks) {
        if(!(bool)block["enabled"])continue;
        if(!(bool)block["loaded"]||(bool)block["modelLoading"]||(bool)block["loadFailed"])return false;
        if(block["lane"].toString()=="left")left=true;else right=true;
    }
    return left&&right;
}

void Tone3000StageSession::begin(uint64_t requested,uint32_t operation,const juce::String& payload) {
    auto retained=shared_from_this();std::lock_guard lock(mutex);
    if(!owner||requested!=token)return;
    try {
        if(operation==TONE3000_STAGE_CANCEL||cancelRequested){cancelNative();finish("cancelled");return;}
        if(!active)return;
        auto state=runtime();
        if(operation==TONE3000_STAGE_RUNTIME){finish("done");return;}
        juce::var argument;
        if(payload.isNotEmpty()) {
            auto parse=juce::JSON::parse(payload,argument);
            if(parse.failed()||!argument.isObject()){finish("failed");return;}
        }
        if(operation==TONE3000_STAGE_LINKED_PAN||operation==TONE3000_STAGE_EXCLUSIVE_SOLO) {
            if(!(bool)state["stereoEnabled"]){finish("notApplicable");return;}
            auto* obj=argument.getDynamicObject();
            if(!obj||obj->getProperties().size()!=(operation==TONE3000_STAGE_LINKED_PAN?2:1)){finish("failed");return;}
            bool moveLeft=true,mirror=true;
            float left=0,right=0;
            const char* leftId=operation==TONE3000_STAGE_LINKED_PAN?"chainPanLeft":"chainSoloLeft";
            const char* rightId=operation==TONE3000_STAGE_LINKED_PAN?"chainPanRight":"chainSoloRight";
            if(operation==TONE3000_STAGE_LINKED_PAN) {
                auto value=argument["value"];if(!number(value)||!std::isfinite((double)value)||(double)value<0||(double)value>1){finish("failed");return;}
                auto side=argument["side"].toString();
                if(!argument["side"].isString()||(side!="left"&&side!="right")){finish("failed");return;}
                if(!(bool)state["stereoOutput"]){finish("notApplicable");return;}
                moveLeft=side=="left";
                auto* linked=owner->parameters.getParameter("chainPanLinked");
                if(!linked){finish("failed");return;}
                mirror=linked->getValue()>.5f;
                if(moveLeft){left=juce::jlimit(0.0f,.5f,(float)value);right=1.0f-left;}
                else{right=juce::jlimit(.5f,1.0f,(float)value);left=1.0f-right;}
            } else {
                auto side=argument["side"].toString();if(!argument["side"].isString()||(side!="left"&&side!="right"&&side!="none")){finish("failed");return;}
                left=side=="left"?1.0f:0.0f;right=side=="right"?1.0f:0.0f;
            }
            auto* l=owner->parameters.getParameter(leftId);auto* r=owner->parameters.getParameter(rightId);
            if(!l||!r){finish("failed");return;}
            {
                juce::ScopedLock callback(owner->getCallbackLock());
                if(mirror||moveLeft){l->beginChangeGesture();l->setValueNotifyingHost(left);l->endChangeGesture();}
                if(mirror||!moveLeft){r->beginChangeGesture();r->setValueNotifyingHost(right);r->endChangeGesture();}
            }
            finish("done");return;
        }
        // Parameter listeners also run for RT patch/MIDI updates outside the
        // wrapper's callback lock. Snapshot before arming, never after rendering
        // may have started, so an in-flight change cannot become the baseline.
        // @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5] [7.6]
        chainRevision=(int)state["revision"];baselineParameters=parameterRevision.load(std::memory_order_relaxed);
        if(operation==TONE3000_STAGE_MEASURE_OUTPUT) {
            double seconds=3;
            if(payload.isNotEmpty()) {
                auto* obj=argument.getDynamicObject();auto value=argument["seconds"];
                if(!obj||obj->getProperties().size()!=1||!number(value)){finish("failed");return;}seconds=(double)value;
            }
            if(!std::isfinite(seconds)||seconds<1||seconds>10||!(bool)state["audioActive"]||owner->isNonRealtime()){finish("notApplicable");return;}
            juce::ScopedLock callback(owner->getCallbackLock());
            if(!meter.arm(owner->getSampleRate(),seconds)){finish("notApplicable");return;}
            deadlineMs=juce::Time::getMillisecondCounterHiRes()+seconds*1000+5000;
        } else {
            if(payload.isNotEmpty()){finish("failed");return;}
            if(!liveStereo(state)){finish("notApplicable");return;}
            juce::ScopedLock callback(owner->getCallbackLock());
            if(operation==TONE3000_STAGE_AUTO_BALANCE)owner->startAutoBalance();else owner->startAutoOffset();
            deadlineMs=juce::Time::getMillisecondCounterHiRes()+(operation==TONE3000_STAGE_AUTO_BALANCE?20000:5000);
        }
        timerLifetime=retained;startTimer(50);auto value=object();value->setProperty("state","listening");publish(value);
    } catch(const std::exception&){cancelNative();finish("failed");}
}

void Tone3000StageSession::timerCallback() {
    auto retained=shared_from_this();std::lock_guard lock(mutex);
    if(!owner||!active)return;
    try {
        if(cancelRequested){cancelNative();finish("cancelled");return;}
        auto observed=runtime();
        if(parameterRevision.load(std::memory_order_relaxed)!=baselineParameters
            ||(int)observed["revision"]!=chainRevision){cancelNative();finish("cancelled");return;}
        if(command!=TONE3000_STAGE_MEASURE_OUTPUT&&!liveStereo(observed)){cancelNative();finish("notApplicable");return;}
        if(juce::Time::getMillisecondCounterHiRes()>deadlineMs){cancelNative();finish("timeout");return;}
        if(command==TONE3000_STAGE_MEASURE_OUTPUT) {
            if(!meter.complete())return;
            const auto measured=meter.result();auto value=object();
            value->setProperty("state","done");value->setProperty("seconds",measured.seconds);value->setProperty("samples",(juce::int64)measured.samples);
            value->setProperty("channels",measured.channels);value->setProperty("finite",measured.finite);value->setProperty("clipped",measured.clipped);value->setProperty("silent",measured.silent);
            value->setProperty("valid",measured.valid);
            finiteField(*value,"rmsDb",measured.rms>0?20*std::log10(measured.rms):std::numeric_limits<double>::quiet_NaN());
            finiteField(*value,"peakDb",measured.peak>0?20*std::log10(measured.peak):std::numeric_limits<double>::quiet_NaN());
            publish(value);active=false;meter.cancel();stopTimer();timerLifetime.reset();return;
        }
        ownCompletionWrites.store(true,std::memory_order_relaxed);
        auto value=command==TONE3000_STAGE_AUTO_BALANCE?owner->pollAutoBalance():owner->pollAutoOffset();
        ownCompletionWrites.store(false,std::memory_order_relaxed);
        auto* native=value.getDynamicObject();if(!native){cancelNative();finish("failed");return;}
        auto state=value["state"].toString();
        auto resultObject=object();resultObject->setProperty("state",state);
        for(const auto* field:{"progress","matchedDb","matchedMs","polarityFlipped","confidence","peakSharpness"})
            if(native->hasProperty(field)) {
                const auto fieldValue=value[field];
                if(number(fieldValue)&&!std::isfinite((double)fieldValue)){cancelNative();finish("failed");return;}
                resultObject->setProperty(field,fieldValue);
            }
        publish(resultObject);
        if(doneState(state)){active=false;stopTimer();timerLifetime.reset();}
        else if(state=="idle"){cancelNative();finish("notApplicable");}
    } catch(const std::exception&){ownCompletionWrites.store(false,std::memory_order_relaxed);cancelNative();finish("failed");}
}

void Tone3000StageSession::measure(const juce::AudioBuffer<float>& buffer) noexcept {
    meter.add(buffer.getArrayOfReadPointers(),buffer.getNumChannels(),(uint64_t)buffer.getNumSamples());
}

int32_t TONE3000Processor::submitStageRequest(uint64_t token,uint32_t command,const char* request,uint32_t size){return stageSession->submit(token,command,request,size);}
int32_t TONE3000Processor::readStageResult(uint64_t token,char* result,uint32_t capacity){return stageSession->read(token,result,capacity);}

juce::var TONE3000Processor::getStageRuntime() {
    auto state=getChainState(-1);auto output=object();juce::Array<juce::var> blocks;
    output->setProperty("revision",state["revision"]);output->setProperty("stereoEnabled",state["stereoEnabled"]);output->setProperty("audioActive",isAudioActive());
    output->setProperty("stereoInput",state["stereoInput"]);output->setProperty("stereoOutput",state["stereoOutput"]);
    output->setProperty("capabilities",juce::Array<juce::var>{"autoBalance","autoAlign","outputMeasure","linkedPan","exclusiveSolo"});
    bool truncated=false;
    for(const auto* name:{"chain","chainRight"})if(auto* lane=state[name].getArray())for(const auto& row:*lane) {
        if(row["kind"].toString()=="insert")continue;
        if(blocks.size()>=32){truncated=true;continue;}
        auto block=object();block->setProperty("lane",juce::String(name)=="chain"?"left":"right");
        for(const auto* key:{"blockId","loaded","modelLoading","loadFailed","inputLevelDbu","outputLevelDbu"})
            if(row.getDynamicObject()->hasProperty(key))block->setProperty(key,row[key]);
        block->setProperty("enabled",row["params"]["enabled"]);block->setProperty("requestedSlimSize",row["params"]["slimSize"]);
        block->setProperty("a2Known",false);block->setProperty("effectiveSlimKnown",false);
        // Query only a currently loaded native engine, never infer A2 from title/extension.
        {juce::ScopedLock lock(chainMutex);
            if(auto found=findBlockById(row["blockId"].toString().toStdString());found&&found->namEngine) {
                auto& engine=*found->namEngine;block->setProperty("a2Known",true);block->setProperty("a2Supported",engine.stageSupportsSlim());
                juce::Array<juce::var> breaks;for(double point:engine.stageSlimBreakpoints())if(std::isfinite(point)&&point>0&&point<1)breaks.add(point);
                block->setProperty("slimBreakpoints",breaks);
                const bool knownCount=!engine.stageSupportsSlim()||!breaks.isEmpty();
                block->setProperty("slimSizeCountKnown",knownCount);
                block->setProperty("slimSizeCount",knownCount?juce::var(breaks.size()+1):juce::var());
            }
        }
        blocks.add(juce::var(block.get()));
    }
    output->setProperty("blocks",blocks);output->setProperty("truncated",truncated);return juce::var(output.get());
}

bool NamEngine::stageSupportsSlim() const {return dynamic_cast<nam::SlimmableModel*>(&primary())!=nullptr;}
std::vector<double> NamEngine::stageSlimBreakpoints() const {
    if(auto* slim=dynamic_cast<nam::SlimmableModel*>(&primary()))return slim->GetSlimmableSizeBreakpoints();return {};
}
