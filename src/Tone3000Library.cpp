// Copyright (c) 2026 Thomas Rapolani
// SPDX-License-Identifier: MIT
#include "Tone3000Library.hpp"
#include "Tone3000Preset.hpp"
#include "AesDigest.hpp"
#include "PiPedalException.hpp"
#include <algorithm>
#include <cerrno>
#include <fcntl.h>
#include <iterator>
#include <map>
#include <set>
#include <sys/stat.h>
#include <tuple>
#include <unistd.h>

using namespace pipedal;
namespace fs = std::filesystem;

JSON_MAP_BEGIN(Tone3000LibraryImport)
JSON_MAP_REFERENCE(Tone3000LibraryImport, bankId)
JSON_MAP_REFERENCE(Tone3000LibraryImport, presetId)
JSON_MAP_REFERENCE(Tone3000LibraryImport, instanceId)
JSON_MAP_REFERENCE(Tone3000LibraryImport, name)
JSON_MAP_REFERENCE(Tone3000LibraryImport, sha256)
JSON_MAP_REFERENCE(Tone3000LibraryImport, active)
JSON_MAP_REFERENCE(Tone3000LibraryImport, hasSnapshotOverrides)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000LibraryEntry)
JSON_MAP_REFERENCE(Tone3000LibraryEntry, key)
JSON_MAP_REFERENCE(Tone3000LibraryEntry, name)
JSON_MAP_REFERENCE(Tone3000LibraryEntry, source)
JSON_MAP_REFERENCE(Tone3000LibraryEntry, sha256)
JSON_MAP_REFERENCE(Tone3000LibraryEntry, imports)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000LibraryResult)
JSON_MAP_REFERENCE(Tone3000LibraryResult, entries)
JSON_MAP_REFERENCE(Tone3000LibraryResult, warnings)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000ImportRequest)
JSON_MAP_REFERENCE(Tone3000ImportRequest, key)
JSON_MAP_REFERENCE(Tone3000ImportRequest, sha256)
JSON_MAP_REFERENCE(Tone3000ImportRequest, bankId)
JSON_MAP_REFERENCE(Tone3000ImportRequest, presetId)
JSON_MAP_REFERENCE(Tone3000ImportRequest, instanceId)
JSON_MAP_REFERENCE(Tone3000ImportRequest, expectedImportSha256)
JSON_MAP_REFERENCE(Tone3000ImportRequest, asNew)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000ImportResult)
JSON_MAP_REFERENCE(Tone3000ImportResult, bankId)
JSON_MAP_REFERENCE(Tone3000ImportResult, presetId)
JSON_MAP_REFERENCE(Tone3000ImportResult, instanceId)
JSON_MAP_END()
JSON_MAP_BEGIN(Tone3000LoadRequest)
JSON_MAP_REFERENCE(Tone3000LoadRequest, bankId)
JSON_MAP_REFERENCE(Tone3000LoadRequest, presetId)
JSON_MAP_END()

namespace {
/** Open every ancestor without following links, including during an app save.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-LIBRARY] [3.9]
 */
int OpenRegular(const fs::path& path) {
    int directory=open("/",O_PATH|O_DIRECTORY|O_NOFOLLOW);
    if (directory<0) throw PiPedalStateException("Unable to open preset filesystem root.");
    try {
        auto relative=path.relative_path();
        for (auto it=relative.begin();it!=relative.end();++it) {
            bool last=std::next(it)==relative.end();
            int flags=last ? O_RDONLY|O_NOFOLLOW|O_NONBLOCK : O_PATH|O_DIRECTORY|O_NOFOLLOW;
            int next=openat(directory,it->c_str(),flags);
            if (next<0) throw PiPedalStateException("Unable to read preset path; check source permissions and refresh.");
            close(directory); directory=next;
        }
        return directory;
    } catch (...) { close(directory); throw; }
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-LIBRARY] [3.9] */
void CheckPath(const fs::path& path) try {
    if (!path.is_absolute() || path.lexically_normal() != path)
        throw PiPedalArgumentException("Library paths must be absolute and normalized.");
    fs::path part;
    for (const auto& component: path) {
        part /= component;
        auto status = fs::symlink_status(part);
        if (fs::is_symlink(status)) throw PiPedalArgumentException("Linked library paths are not permitted.");
    }
} catch (const fs::filesystem_error&) {
    throw PiPedalStateException("Library path is unavailable; check source permissions and refresh.");
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-LIBRARY] [3.9] */
void PrivateDirectory(const fs::path& path) {
    CheckPath(path);
    fs::create_directories(path);
    CheckPath(path);
    if (!fs::is_directory(path) || chmod(path.c_str(), 0700) != 0)
        throw PiPedalStateException("Unable to prepare private library storage.");
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
std::string Digest(const std::vector<uint8_t>& bytes) {
    return AesDigest(std::string(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-LIBRARY] [3.9] */
void WritePrivate(const fs::path& path, const std::vector<uint8_t>& bytes, bool replace) {
    CheckPath(path.parent_path());
    std::string pattern = (path.parent_path() / ".tone3000-XXXXXX").string();
    std::vector<char> temporary(pattern.begin(), pattern.end()); temporary.push_back(0);
    int fd = mkstemp(temporary.data());
    if (fd < 0) throw PiPedalStateException("Unable to create private preset file.");
    fs::path temp(temporary.data());
    try {
        size_t done = 0;
        while (done < bytes.size()) {
            ssize_t count = write(fd, bytes.data()+done, bytes.size()-done);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) throw PiPedalStateException("Unable to write private preset file.");
            done += static_cast<size_t>(count);
        }
        if (fsync(fd) != 0) throw PiPedalStateException("Unable to sync private preset file.");
        close(fd); fd = -1;
        CheckPath(path);
        if (!replace && fs::exists(path)) throw PiPedalStateException("Private backup filename collision.");
        fs::rename(temp, path);
        int directory = open(path.parent_path().c_str(), O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
        if (directory < 0) throw PiPedalStateException("Unable to open private storage directory.");
        int result = fsync(directory); close(directory);
        if (result != 0) throw PiPedalStateException("Preset published, but directory sync failed; inspect library before retry.");
    } catch (...) {
        if (fd >= 0) close(fd);
        std::error_code ignored; fs::remove(temp, ignored);
        throw;
    }
}
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
Tone3000Library::Tone3000Library(const fs::path& dataRoot, const std::vector<std::string>& appRoots): dataRoot(dataRoot) {
    if (appRoots.size() > 8) throw PiPedalArgumentException("Too many configured app preset roots.");
    for (size_t i=0;i<appRoots.size();++i) {
        fs::path path(appRoots[i]);
        if (!path.is_absolute() || path.lexically_normal()!=path)
            throw PiPedalArgumentException("Configured app preset roots must be absolute and normalized.");
        std::string rootKey=AesDigest(path.string());
        roots.push_back({path,"app-"+rootKey,"Pi app","user"});
        roots.push_back({path/"Factory","app-factory-"+rootKey,"Pi app factory","factory"});
    }
    fs::path service = dataRoot/"home/.config/TONE3000/Presets";
    roots.push_back({service,"service","Service","user"});
    roots.push_back({service/"Factory","service-factory","Service factory","factory"});
    roots.push_back({"/usr/share/TONE3000/Presets/Factory","system","Installed factory","factory"});
    roots.push_back({dataRoot/"tone3000-library/uploads","uploaded","Uploaded","user"});
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
Tone3000Library::Tone3000Library(const fs::path& dataRoot, std::vector<Root> roots): dataRoot(dataRoot), roots(std::move(roots)) {}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-LIBRARY] [3.9] */
bool Tone3000Library::ValidFilename(const std::string& name) {
    if (name.size() <= 10 || name.size() > 240 || !name.ends_with(".t3kpreset") || name.front()=='.' || name.front()=='~') return false;
    for (unsigned char c: name) if (c < 32 || c == 127 || c=='/' || c=='\\' || c==':' || c=='*' || c=='?' || c=='"' || c=='<' || c=='>' || c=='|') return false;
    return name.find("..") == std::string::npos;
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
bool Tone3000Library::IsToneBank(const std::string& name) { return name.starts_with("TONE3000"); }

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-SEC] [DES-LIBRARY] [3.9] */
std::vector<uint8_t> Tone3000Library::ReadFile(const fs::path& path, size_t limit) {
    CheckPath(path);
    int fd = OpenRegular(path);
    try {
        struct stat before{}, after{}, named{};
        if (fstat(fd,&before)!=0 || !S_ISREG(before.st_mode) || before.st_nlink!=1 || before.st_size<0 || static_cast<uint64_t>(before.st_size)>limit)
            throw PiPedalArgumentException("Preset file type or size is unsupported.");
        std::vector<uint8_t> bytes(static_cast<size_t>(before.st_size));
        size_t done=0;
        while (done<bytes.size()) {
            ssize_t count=read(fd,bytes.data()+done,bytes.size()-done);
            if (count<0 && errno==EINTR) continue;
            if (count<=0) throw PiPedalStateException("Preset changed while reading; refresh and retry.");
            done+=static_cast<size_t>(count);
        }
        if (fstat(fd,&after)!=0 || lstat(path.c_str(),&named)!=0 || before.st_size!=after.st_size
            || before.st_mtim.tv_sec!=after.st_mtim.tv_sec || before.st_mtim.tv_nsec!=after.st_mtim.tv_nsec
            || before.st_ctim.tv_sec!=after.st_ctim.tv_sec || before.st_ctim.tv_nsec!=after.st_ctim.tv_nsec
            || before.st_dev!=named.st_dev || before.st_ino!=named.st_ino)
            throw PiPedalStateException("Preset changed while reading; refresh and retry.");
        close(fd); return bytes;
    } catch (...) { close(fd); throw; }
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
std::vector<Tone3000Library::Source> Tone3000Library::Scan(std::vector<std::string>* warnings) const {
    std::vector<Source> result;
    std::map<std::pair<std::string,std::string>,size_t> versions;
    size_t fileCount=0;
    for (const auto& root: roots) {
        try {
            CheckPath(root.path);
            if (!fs::exists(root.path)) continue;
            std::vector<Source> local;
            std::map<std::string,std::string> identities;
            std::set<std::string> conflicts;
            std::map<std::string,std::string> ids;
            for (const auto& file: fs::directory_iterator(root.path)) {
                if (++fileCount>2000) throw PiPedalArgumentException("Library scan exceeds 2000 entries.");
                std::string filename=file.path().filename().string();
                if (!filename.ends_with(".t3kpreset")) continue;
                try {
                    if (!ValidFilename(filename)) throw PiPedalArgumentException("Unsafe preset basename.");
                    auto bytes=ReadFile(file.path());
                    auto info=Tone3000Preset::Inspect(bytes,filename,root.section);
                    std::string hash=Digest(bytes);
                    auto prior=identities.find(info.id);
                    if (prior!=identities.end() && prior->second!=hash) conflicts.insert(info.id);
                    identities[info.id]=hash;
                    Source source;
                    source.path=file.path(); source.section=root.section;
                    source.entry.key_=root.key+":"+AesDigest(info.id);
                    source.entry.name_=info.name; source.entry.source_=root.source; source.entry.sha256_=hash;
                    ids[source.entry.key_]=info.id;
                    local.push_back(std::move(source));
                } catch (const std::exception&) {
                    if (warnings) warnings->push_back(root.source+": a preset is unreadable, changed, linked or unsupported.");
                }
            }
            for (auto& source: local) if (!conflicts.contains(ids[source.entry.key_])) {
                auto version=std::make_pair(ids[source.entry.key_],source.entry.sha256_);
                auto prior=versions.find(version);
                if (prior==versions.end()) {
                    versions[version]=result.size(); result.push_back(std::move(source));
                } else if (result[prior->second].entry.key_!=source.entry.key_) {
                    result[prior->second].aliases.push_back(source.entry.key_);
                }
            }
            if (!conflicts.empty() && warnings) warnings->push_back(root.source+": conflicting preset identities were excluded.");
        } catch (const std::exception&) {
            if (warnings) warnings->push_back(root.source+": preset folder unavailable or scan limit exceeded.");
        }
    }
    std::sort(result.begin(),result.end(),[](const Source& a,const Source& b) {
        return std::tie(a.entry.name_,a.entry.source_,a.entry.key_)<std::tie(b.entry.name_,b.entry.source_,b.entry.key_);
    });
    return result;
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
Tone3000Library::Source Tone3000Library::Resolve(const std::string& key,const std::string& hash) const {
    for (const auto& source: Scan(nullptr)) if (source.entry.key_==key || std::find(source.aliases.begin(),source.aliases.end(),key)!=source.aliases.end()) {
        if (source.entry.sha256_!=hash) throw PiPedalStateException("Source preset changed; refresh the library before importing.");
        return source;
    }
    throw PiPedalArgumentException("Preset source is unavailable; refresh the library.");
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-SEC] [3.9] */
void Tone3000Library::BackupFile(const fs::path& dataRoot,const fs::path& path) {
    auto bytes=ReadFile(path,256*1024*1024);
    fs::path directory=dataRoot/"tone3000-library/backups";
    PrivateDirectory(dataRoot/"tone3000-library"); PrivateDirectory(directory);
    std::string pattern=(directory/"before-XXXXXX").string();
    std::vector<char> name(pattern.begin(),pattern.end()); name.push_back(0);
    int fd=mkstemp(name.data());
    if (fd<0) throw PiPedalStateException("Unable to retain prewrite backup.");
    close(fd);
    WritePrivate(fs::path(name.data()),bytes,true);
    std::string text=fs::path(name.data()).filename().string()+".sha256";
    auto hash=Digest(bytes);
    WritePrivate(directory/text,std::vector<uint8_t>(hash.begin(),hash.end()),false);
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
Tone3000LibraryEntry Tone3000Library::Upload(const std::string& filename,const fs::path& temporary) try {
    if (!ValidFilename(filename)) throw PiPedalArgumentException("Choose a safe original .t3kpreset filename; names are not rewritten.");
    auto bytes=ReadFile(temporary);
    auto info=Tone3000Preset::Inspect(bytes,filename,"user");
    std::string hash=Digest(bytes);
    for (const auto& existing: Scan(nullptr)) if (existing.entry.sha256_==hash) return existing.entry;
    fs::path directory=dataRoot/"tone3000-library/uploads";
    PrivateDirectory(dataRoot/"tone3000-library"); PrivateDirectory(directory);
    fs::path destination=directory/filename;
    // A different basename carrying the same identity cannot silently replace
    // another source. Identical content is safely reused.
    for (const auto& file: fs::directory_iterator(directory)) {
        if (file.path()==destination || !file.path().filename().string().ends_with(".t3kpreset")) continue;
        auto existing=ReadFile(file.path());
        auto other=Tone3000Preset::Inspect(existing,file.path().filename().string(),"user");
        if (other.id==info.id) {
            if (Digest(existing)!=hash) throw PiPedalArgumentException("Uploaded preset identity conflicts with another filename.");
            return {"uploaded:"+AesDigest(other.id),other.name,"Uploaded",hash,{}};
        }
    }
    if (fs::exists(destination) || fs::is_symlink(fs::symlink_status(destination))) {
        auto existing=ReadFile(destination);
        if (Digest(existing)==hash) return {"uploaded:"+AesDigest(info.id),info.name,"Uploaded",hash,{}};
        BackupFile(dataRoot,destination);
    }
    WritePrivate(destination,bytes,true);
    if (Digest(ReadFile(destination))!=hash) throw PiPedalStateException("Upload publication could not be verified; refresh library.");
    return {"uploaded:"+AesDigest(info.id),info.name,"Uploaded",hash,{}};
} catch (const fs::filesystem_error&) {
    throw PiPedalStateException("Private preset storage is unavailable; inspect permissions before retrying.");
}

/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
bool Tone3000Library::HasSnapshotOverrides(const Pedalboard& board,int64_t id) {
    for (const auto& snapshot: board.snapshots()) if (snapshot)
        for (const auto& value: snapshot->values_) if (value.instanceId_==id) return true;
    return false;
}
/** @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [3.9] */
void Tone3000Library::ApplyState(PedalboardItem& item,const Lv2PluginState& state,const std::string& key,const std::string& hash) {
    if (item.uri()!=Tone3000Preset::PLUGIN_URI) throw PiPedalArgumentException("Import target is not TONE3000.");
    item.lv2State(state); item.lilvPresetUri(""); item.stateUpdateCount(item.stateUpdateCount()+1);
    item.pathProperties({}); item.PatchProperties().clear();
    item.tone3000SourceKey(key); item.tone3000SourceHash(hash);
}
