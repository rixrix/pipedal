// SPDX-License-Identifier: MIT
#include "Tone3000Preset.hpp"
#include "Tone3000Operations.hpp"
#include "Base64.hpp"
#include <iostream>
#include <sstream>
#include <stdexcept>

/** Bounded codec utility; callers own private atomic publication/backup.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-STAGE-EXPORT] [7.11]
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [FR-26] [DES-MIX-MATCH] [7.33]
 */
int main(int argc,char** argv) {
    using namespace pipedal;
    try {
        if(argc<2)throw std::invalid_argument("Use export ID NAME, build/reset BASENAME SECTION, edit, or partition AMP_BLOCK_ID CAB_BLOCK_ID --confirm-amp-head.");
        std::string input;char buffer[8192];
        while(std::cin.read(buffer,sizeof(buffer)) || std::cin.gcount()) {
            if(input.size()+std::cin.gcount()>256*1024*1024)throw std::invalid_argument("Codec input exceeds its bound.");
            input.append(buffer,std::cin.gcount());
        }
        const std::string command=argv[1];
        if(command=="partition" && argc==5 && std::string(argv[4])=="--confirm-amp-head") {
            std::istringstream stream(input);json_reader reader(stream);reader.allowNaN(false);
            Lv2PluginState state;reader.read(&state);
            stream >> std::ws;
            if(!stream.eof())throw std::invalid_argument("Expected exactly one plugin state JSON value.");
            const auto result=Tone3000Preset::PartitionAmpCab(state,argv[2],argv[3],true);
            // Validate both stages before serializing, then buffer the complete result.
            // No validation/encoding failure may publish a partial pair on stdout.
            std::ostringstream output;json_writer writer(output);
            writer.start_object();writer.write_member("ampState",result.ampState);output << ',';
            writer.write_member("cabState",result.cabState);output << ',';
            writer.write_member("ampBlockId",result.ampBlockId);output << ',';
            writer.write_member("cabBlockId",result.cabBlockId);writer.end_object();
            std::cout << output.str();
        } else if(command=="export" && argc==4) {
            std::istringstream stream(input);json_reader reader(stream);reader.allowNaN(false);Lv2PluginState state;reader.read(&state);
            auto bytes=Tone3000Preset::ExportPreset(state,argv[2],argv[3]);
            std::cout.write(reinterpret_cast<const char*>(bytes.data()),bytes.size());
        } else if(command=="build" && argc==4) {
            auto bytes=std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(input.data()),input.size());
            auto state=Tone3000Preset::BuildState(bytes,argv[2],argv[3]);
            json_writer writer(std::cout);writer.write(state);
        } else if(command=="reset" && argc==4) {
            std::istringstream stream(input);json_reader reader(stream);reader.allowNaN(false);json_variant raw;reader.read(&raw);
            if(!raw.is_object() || raw.size()!=3 || !raw.as_object()->contains("state")
               || !raw.as_object()->contains("presetBase64") || !raw.as_object()->contains("defaults")
               || !raw["presetBase64"].is_string()) throw std::invalid_argument("Expected state, presetBase64 and defaults.");
            const auto& encoded=raw["presetBase64"].as_string();
            if(encoded.size()>4*((Tone3000Preset::MAX_BYTES+2)/3)) throw std::invalid_argument("Preset exceeds its bound.");
            for(unsigned char c:encoded) if(!((c>='A' && c<='Z') || (c>='a' && c<='z') || (c>='0' && c<='9') || c=='+' || c=='/' || c=='='))
                throw std::invalid_argument("Invalid preset base64.");
            auto bytes=macaron::Base64::Decode(encoded);
            if(macaron::Base64::Encode(bytes)!=encoded) throw std::invalid_argument("Noncanonical preset base64.");
            std::istringstream stateStream(raw["state"].to_string()),defaultsStream(raw["defaults"].to_string());
            json_reader sr(stateStream),dr(defaultsStream);sr.allowNaN(false);dr.allowNaN(false);
            Lv2PluginState previous;Tone3000ProcessingDefaults defaults;sr.read(&previous);dr.read(&defaults);
            auto state=Tone3000Preset::BuildState(bytes,argv[2],argv[3],&previous);
            auto result=Tone3000Preset::EditState(state,Tone3000Operations::ProcessingPatch(defaults));
            json_writer writer(std::cout);writer.write(result);
        } else if(command=="edit" && argc==2) {
            std::istringstream stream(input);json_reader reader(stream);reader.allowNaN(false);json_variant raw;reader.read(&raw);
            if(!raw.is_object() || raw.size()!=2 || !raw.as_object()->contains("state") || !raw.as_object()->contains("patch"))
                throw std::invalid_argument("Expected state and patch.");
            std::istringstream stateStream(raw["state"].to_string()),patchStream(raw["patch"].to_string());
            json_reader sr(stateStream),pr(patchStream);sr.allowNaN(false);pr.allowNaN(false);Lv2PluginState state;Tone3000StatePatch patch;
            sr.read(&state);pr.read(&patch);
            auto edited=Tone3000Preset::EditState(state,patch);json_writer writer(std::cout);writer.write(edited);
        } else throw std::invalid_argument("Unsupported codec arguments.");
        if(!std::cout)throw std::runtime_error("Codec output failed.");
        return 0;
    } catch(const std::exception& error) {std::cerr<<error.what()<<'\n';return 1;}
}
