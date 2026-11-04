"""Portable tests of the real bridge submit/read methods, without a DSP host."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


class StageSessionTokenTests(unittest.TestCase):
    """@see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-BRIDGE] [7.5]"""
    def test_parameter_change_after_arming_is_never_absorbed_into_baseline(self):
        compiler = shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            self.skipTest("A C++ compiler is required for the actual-method harness")
        here = Path(__file__).resolve().parent
        source = (here / "stage-addon/Tone3000StageSession.cpp").read_text()
        # Compile the actual contiguous arming sequence and first timer guard.
        # Only runtime/applicability context is stubbed; the real RT meter arms
        # and consumes a sample before the injected asynchronous parameter change.
        begin_start = source.index("// Parameter listeners also run")
        begin = source[begin_start:source.index("timerLifetime=retained;startTimer", begin_start)]
        guard = source[source.index("if(parameterRevision.load("):
                       source.index("if(command!=TONE3000_STAGE_MEASURE_OUTPUT")]
        harness = r'''
#include "Tone3000StageBridge.hpp"
#include "stage-addon/Tone3000StageMeter.hpp"
#include <atomic>
#include <cassert>
#include <cmath>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
namespace juce {
struct DynamicObject {struct Properties {int size(){return 0;}};Properties getProperties(){return {};}};
struct var {
    double value=1;
    var operator[](const char* key)const{return {std::strcmp(key,"revision")==0?7.0:1.0};}
    operator double()const{return value;}
    DynamicObject* getDynamicObject(){return nullptr;}
};
struct String {bool isNotEmpty()const{return false;}};
struct ScopedLock {explicit ScopedLock(std::mutex&) {}};
struct Time {static double getMillisecondCounterHiRes(){return 0;}};
}
bool number(const juce::var&){return true;}
struct Owner {
    std::function<void()> afterStart;
    std::mutex callback;
    bool isNonRealtime(){return false;}
    std::mutex& getCallbackLock(){return callback;}
    double getSampleRate(){return 48000;}
    void startAutoBalance(){if(afterStart)afterStart();}
    void startAutoOffset(){if(afterStart)afterStart();}
};
struct Meter:Tone3000StageMeter {
    std::function<void()> afterStart;
    bool arm(double rate,double seconds){
        const bool result=Tone3000StageMeter::arm(rate,seconds);
        if(result){float sample=.1f;const float* channels[]={&sample};add(channels,1,1);if(afterStart)afterStart();}
        return result;
    }
};
class Session {
public:
    Owner* owner;
    Meter meter;
    std::atomic<uint64_t> parameterRevision{0};
    uint64_t baselineParameters=0;
    int chainRevision=0;
    double deadlineMs=0;
    std::string result;
    bool cancelled=false;
    bool liveStereo(const juce::var&){return true;}
    void finish(const char* state){result=state;}
    void cancelNative(){cancelled=true;}
    void begin(uint32_t operation){juce::String payload;juce::var state,argument;
''' + begin + r'''
    }
    void poll(){juce::var observed;
''' + guard + r'''
        finish("done");
    }
};
int main(){
    for(uint32_t command:{TONE3000_STAGE_MEASURE_OUTPUT,TONE3000_STAGE_AUTO_BALANCE,TONE3000_STAGE_AUTO_ALIGN}){
        for(bool change:{false,true}){
            Owner owner;Session session;session.owner=&owner;
            auto update=[&]{if(change)session.parameterRevision.fetch_add(1);};
            owner.afterStart=update;session.meter.afterStart=update;
            session.begin(command);session.poll();
            assert(session.result==(change?"cancelled":"done"));
            assert(session.cancelled==change);
            assert(session.baselineParameters==0);
        }
    }
}
'''
        temporary_root = "/private/tmp" if Path("/private/tmp").is_dir() else None
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            cpp = Path(directory) / "baseline.cpp"
            binary = Path(directory) / "baseline-test"
            cpp.write_text(harness)
            subprocess.run([compiler, "-std=c++20", "-O1", "-g", "-fno-fast-math", "-fsanitize=address,undefined",
                            "-I", str(here), str(cpp), "-o", str(binary)], check=True,
                           capture_output=True, text=True, timeout=60)
            subprocess.run([str(binary)], check=True, capture_output=True, text=True, timeout=10)

    def test_shutdown_releases_session_even_when_last_message_queue_discards_cleanup(self):
        compiler = shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            self.skipTest("A C++ compiler is required for the actual-method harness")
        source = (Path(__file__).resolve().parent / "stage-addon/Tone3000StageSession.cpp").read_text()
        shutdown = source[source.index("void Tone3000StageSession::shutdown()"):
                          source.index("void Tone3000StageSession::cancelNative()")]
        destructor = next(line for line in source.splitlines() if line.startswith("Tone3000StageSession::~"))
        harness = r'''
#include <cassert>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>
namespace juce {
struct MessageManager {
    static inline bool accepting=true;
    static inline std::vector<std::function<void()>> queue;
    static bool callAsync(std::function<void()> callback){
        if(!accepting)return false;
        queue.push_back(std::move(callback));return true;
    }
};
}
struct Owner {struct Params {void removeParameterListener(const std::string&,void*){}}parameters;};
class Tone3000StageSession:public std::enable_shared_from_this<Tone3000StageSession>{
public:
    ~Tone3000StageSession();
    void shutdown();
    void stopTimer(){++stops;}
    void cancelNative(){++cancels;}
    static inline int stops=0,cancels=0;
    std::mutex mutex;
    Owner* owner=nullptr;
    std::vector<std::string> parameterIds;
    std::shared_ptr<Tone3000StageSession> timerLifetime;
    bool active=true;
};
''' + destructor + "\n" + shutdown + r'''
int main(){
    Owner owner;
    for(int mode=0;mode<4;++mode){
        juce::MessageManager::accepting=mode!=2;
        auto session=std::make_shared<Tone3000StageSession>();session->owner=&owner;
        if(mode!=3)session->timerLifetime=session;
        std::weak_ptr<Tone3000StageSession> weak=session;
        const auto cancelled=Tone3000StageSession::cancels;
        session->shutdown();session->shutdown();
        assert(Tone3000StageSession::cancels==cancelled+1);
        assert(!session->owner&&!session->active&&!session->timerLifetime);
        session.reset();
        if(mode<2){
            assert(!weak.expired()); // Cleanup capture owns an in-flight timer.
            assert(juce::MessageManager::queue.size()==1);
            if(mode==0)juce::MessageManager::queue.front()();
            // Mode1 reproduces last-wrapper teardown discarding queued work.
            juce::MessageManager::queue.clear();
        }
        assert(weak.expired());
        assert(juce::MessageManager::queue.empty());
    }
    assert(Tone3000StageSession::stops>=4);
}
'''
        temporary_root = "/private/tmp" if Path("/private/tmp").is_dir() else None
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            cpp = Path(directory) / "shutdown.cpp"
            binary = Path(directory) / "shutdown-test"
            cpp.write_text(harness)
            subprocess.run([compiler, "-std=c++20", "-O1", "-g", "-fsanitize=address,undefined",
                            str(cpp), "-o", str(binary)], check=True,
                           capture_output=True, text=True, timeout=60)
            subprocess.run([str(binary)], check=True, capture_output=True, text=True, timeout=10)

    def test_cancel_restores_boolean_and_numeric_block_baselines(self):
        compiler = shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            self.skipTest("A C++ compiler is required for the actual-method harness")
        source = (Path(__file__).resolve().parent / "stage-addon/Tone3000StageSession.cpp").read_text()
        restore = source[source.index("void Tone3000StageSession::restoreBlockEdit()"):
                         source.index("void Tone3000StageSession::begin(")]
        harness = r'''
#include <cassert>
#include <cmath>
#include <string>
namespace juce {
struct String {
    std::string value;
    String()=default; String(const char* value):value(value){}
    bool isEmpty()const{return value.empty();}
    std::string toStdString()const{return value;}
    bool operator==(const char* other)const{return value==other;}
};
struct var {
    enum class Type {Void,Bool,Number,Object}; Type type=Type::Void; double value=0;
    var()=default; var(bool value):type(Type::Bool),value(value?1:0){} var(double value):type(Type::Number),value(value){}
    static var object(){var result;result.type=Type::Object;return result;}
    bool isVoid()const{return type==Type::Void;} bool isBool()const{return type==Type::Bool;}
    bool isObject()const{return type==Type::Object;} operator bool()const{return value!=0;} operator double()const{return value;}
};
}
bool number(const juce::var& value){return value.type==juce::var::Type::Number;}
bool unit(double value){return std::isfinite(value)&&value>=0&&value<=1;}
struct Owner {
    int calls=0;std::string method,param;double value=-1;int index=-1;
    bool setBlockParam(const std::string&,const juce::String& p,double v){++calls;method="param";param=p.value;value=v;return true;}
    bool setBlockEqEnabled(const std::string&,bool v){++calls;method="enabled";value=v;return true;}
    bool setBlockEqPre(const std::string&,bool v){++calls;method="pre";value=v;return true;}
    bool setBlockEqBand(const std::string&,int i,const juce::var&){++calls;method="band";index=i;return true;}
};
class Tone3000StageSession {
public:
    void restoreBlockEdit();
    Owner* owner=nullptr;juce::String blockEditId,blockEditKind,blockEditParam;int blockEditBand=-1;juce::var blockEditBaseline;
};
''' + restore + r'''
int main(){
    Owner owner;Tone3000StageSession session;session.owner=&owner;session.blockEditId="amp";session.blockEditKind="param";
    session.blockEditParam="enabled";session.blockEditBaseline=true;session.restoreBlockEdit();
    assert(owner.calls==1&&owner.method=="param"&&owner.param=="enabled"&&owner.value==1);
    session.blockEditParam="normalize";session.blockEditBaseline=false;session.restoreBlockEdit();
    assert(owner.calls==2&&owner.param=="normalize"&&owner.value==0);
    session.blockEditParam="mix";session.blockEditBaseline=juce::var(.35);session.restoreBlockEdit();
    assert(owner.calls==3&&owner.param=="mix"&&std::abs(owner.value-.35)<1e-12);
    session.blockEditParam="mix";session.blockEditBaseline=true;session.restoreBlockEdit();
    assert(owner.calls==3); // Wrong native baseline type cannot invent a restore value.
    session.blockEditKind="eqEnabled";session.blockEditBaseline=false;session.restoreBlockEdit();
    assert(owner.calls==4&&owner.method=="enabled"&&owner.value==0);
    session.blockEditKind="eqPre";session.blockEditBaseline=true;session.restoreBlockEdit();
    assert(owner.calls==5&&owner.method=="pre"&&owner.value==1);
    session.blockEditKind="eqBand";session.blockEditBand=4;session.blockEditBaseline=juce::var::object();session.restoreBlockEdit();
    assert(owner.calls==6&&owner.method=="band"&&owner.index==4);
}
'''
        temporary_root = "/private/tmp" if Path("/private/tmp").is_dir() else None
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            cpp = Path(directory) / "block-restore.cpp"
            binary = Path(directory) / "block-restore-test"
            cpp.write_text(harness)
            subprocess.run([compiler, "-std=c++20", "-O1", "-g", "-fno-fast-math", "-fsanitize=address,undefined",
                            str(cpp), "-o", str(binary)], check=True,
                           capture_output=True, text=True, timeout=60)
            subprocess.run([str(binary)], check=True, capture_output=True, text=True, timeout=10)

    def test_completed_cancel_retains_receipt_and_active_cancel_still_queues(self):
        compiler = shutil.which("clang++") or shutil.which("g++")
        if not compiler:
            self.skipTest("A C++ compiler is required for the actual-method harness")
        here = Path(__file__).resolve().parent
        source = (here / "stage-addon/Tone3000StageSession.cpp").read_text()
        methods = source[source.index("int32_t Tone3000StageSession::submit("):
                         source.index("void Tone3000StageSession::shutdown()")]
        # Compile the actual checked-in methods. The JUCE message-queue stub only
        # counts queued callbacks; completion fixtures use the real terminal contract.
        harness = r'''
#include "Tone3000StageBridge.hpp"
#include <cassert>
#include <cstring>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
namespace juce {
struct String { static String fromUTF8(const char*,int){return {};} void clear(){} };
struct var {};
struct MessageManager {
    static inline int queued=0;
    static bool callAsync(std::function<void()>){++queued;return true;}
};
}
class Tone3000StageSession:public std::enable_shared_from_this<Tone3000StageSession> {
public:
    int32_t submit(uint64_t,uint32_t,const char*,uint32_t);
    int32_t read(uint64_t,char*,uint32_t);
    void begin(uint64_t,uint32_t,const juce::String&){}
    std::mutex mutex;
    void* owner=this;
    uint64_t token=0;
    uint32_t command=0;
    bool active=false,cancelRequested=false;
    std::string result;
    juce::String blockEditId,blockEditKind,blockEditParam;
    int blockEditBand=-1;
    juce::var blockEditBaseline;
    bool blockEditCommitted=false;
};
''' + methods + r'''
int main(){
    auto session=std::make_shared<Tone3000StageSession>(); char output[256];
    assert(session->submit(7,TONE3000_STAGE_LINKED_PAN,nullptr,0)==0);
    assert(juce::MessageManager::queued==1);
    assert(session->read(7,output,sizeof output)==0);
    assert(session->submit(8,TONE3000_STAGE_RUNTIME,nullptr,0)==TONE3000_STAGE_BUSY);
    session->active=false;
    session->result="{\"state\":\"done\",\"command\":6}";
    const auto completed=session->result;
    assert(session->submit(7,TONE3000_STAGE_CANCEL,nullptr,0)==0);
    assert(juce::MessageManager::queued==1);
    assert(!session->cancelRequested);
    assert(session->read(7,output,sizeof output)==int(completed.size()+1));
    assert(output==completed);
    assert(session->read(7,output,1)==TONE3000_STAGE_CAPACITY);
    assert(session->submit(7,TONE3000_STAGE_RUNTIME,nullptr,0)==TONE3000_STAGE_STALE);
    assert(session->submit(6,TONE3000_STAGE_CANCEL,nullptr,0)==TONE3000_STAGE_STALE);
    assert(session->submit(7,TONE3000_STAGE_CANCEL,"x",1)==TONE3000_STAGE_INVALID);
    assert(session->submit(8,TONE3000_STAGE_AUTO_ALIGN,nullptr,0)==0);
    assert(session->active&&session->result.empty());
    session->result="{\"state\":\"listening\"}";
    assert(session->submit(8,TONE3000_STAGE_CANCEL,nullptr,0)==0);
    assert(session->cancelRequested&&session->result.empty());
    assert(juce::MessageManager::queued==3);
    session->active=false; session->result="{\"state\":\"cancelled\"}";
    assert(session->submit(8,TONE3000_STAGE_CANCEL,nullptr,0)==0);
    assert(session->read(8,output,sizeof output)>0);
    assert(std::string(output)==session->result);
    assert(juce::MessageManager::queued==3);
}
'''
        temporary_root = "/private/tmp" if Path("/private/tmp").is_dir() else None
        with tempfile.TemporaryDirectory(dir=temporary_root) as directory:
            cpp = Path(directory) / "session.cpp"
            binary = Path(directory) / "session-test"
            cpp.write_text(harness)
            subprocess.run([compiler, "-std=c++20", "-O1", "-g", "-fsanitize=address,undefined",
                            "-I", str(here), str(cpp), "-o", str(binary)], check=True,
                           capture_output=True, text=True, timeout=60)
            subprocess.run([str(binary)], check=True, capture_output=True, text=True, timeout=10)


if __name__ == "__main__":
    unittest.main()
