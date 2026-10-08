// Copyright (c) Robin E.R. Davies
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of
// this software and associated documentation files (the "Software"), to deal in
// the Software without restriction, including without limitation the rights to
// use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software is furnished to do so,
// subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
// FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
#include "pch.h"
#include "catch.hpp"

#include "WebServer.hpp"
#include "MemDebug.hpp"
#include <iostream>
#include <boost/asio.hpp>
#include <chrono>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <iterator>
#include <sys/stat.h>
#include <unistd.h>

using namespace pipedal;

namespace pipedal::detail {
std::vector<std::pair<size_t, bool>> ConsumeFileUploadForTest(
    const std::filesystem::path&, const std::vector<std::string>&, std::error_code&,
    const std::function<void(const std::filesystem::path&, std::istream&)>&);
}

namespace {
class StaticFileServer {
    using Tcp=boost::asio::ip::tcp;
    boost::asio::io_context io;
    std::shared_ptr<WebServer> server;
public:
    std::filesystem::path root;
    uint16_t port=0;
    StaticFileServer() {
        auto pattern=(std::filesystem::canonical(std::filesystem::temp_directory_path())/"pipedal-static-test-XXXXXX").string();
        std::vector<char> name(pattern.begin(),pattern.end());name.push_back(0);
        auto directory=mkdtemp(name.data());if(!directory) throw std::runtime_error("Static fixture creation failed");root=directory;
        // Reserve an ephemeral port rather than conflicting with a running host.
        Tcp::acceptor lease(io,Tcp::endpoint(Tcp::v6(),0));port=lease.local_endpoint().port();lease.close();
        server=WebServer::create(boost::asio::ip::address_v6::loopback(),port,root.c_str(),1,1024);
        server->RunInBackground();
    }
    ~StaticFileServer() {
        if(server){server->ShutDown(1000);server->Join();}
        std::error_code ignored;std::filesystem::remove_all(root,ignored);
    }
    void Put(const std::string& path,const std::string& content) {
        std::ofstream out(root/path,std::ios::binary);out<<content;
        if(!out) throw std::runtime_error("Static fixture write failed");
    }
    std::string Get(const std::string& path,bool gzip=false) {
        Tcp::socket socket(io);boost::system::error_code error;
        auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(3);
        do {
            socket.connect(Tcp::endpoint(boost::asio::ip::address_v6::loopback(),port),error);
            if(!error) break;
            socket.close();socket=Tcp::socket(io);
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        } while(std::chrono::steady_clock::now()<deadline);
        if(error) throw std::runtime_error("Static server did not start");
        std::string request="GET "+path+" HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n";
        if(gzip) request+="Accept-Encoding: gzip\r\n";
        request+="\r\n";boost::asio::write(socket,boost::asio::buffer(request));socket.non_blocking(true);
        std::string response;char bytes[4096];
        while(std::chrono::steady_clock::now()<deadline) {
            size_t count=socket.read_some(boost::asio::buffer(bytes),error);response.append(bytes,count);
            if(error==boost::asio::error::eof) return response;
            if(error && error!=boost::asio::error::would_block && error!=boost::asio::error::try_again)
                throw std::runtime_error("Static HTTP response failed");
            if(response.size()>65536) throw std::runtime_error("Static HTTP response exceeds fixture bound");
            if(error) std::this_thread::sleep_for(std::chrono::milliseconds(2));
        }
        throw std::runtime_error("Static HTTP response timed out");
    }
};
}

/** Missing static/gzip metadata returns 404 while the same server remains usable.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-RECOVERY] [3.16]
 */
TEST_CASE("WebServer static metadata errors retain HTTP recovery","[webServerStatic][Build]") {
    StaticFileServer server;server.Put("index.html","still running");
    REQUIRE(server.Get("/missing.js").starts_with("HTTP/1.1 404"));
    REQUIRE(server.Get("/missing.js",true).starts_with("HTTP/1.1 404"));
    server.Put("asset.js","plain asset");
    std::filesystem::create_directory(server.root/"asset.js.gz");
    auto unavailable=server.Get("/asset.js",true);REQUIRE(unavailable.starts_with("HTTP/1.1 404"));
    REQUIRE(unavailable.find("Content-Encoding: gzip")==std::string::npos);
    std::filesystem::remove(server.root/"asset.js.gz");
    std::filesystem::create_symlink("asset.js.gz",server.root/"asset.js.gz");
    auto linked=server.Get("/asset.js",true);REQUIRE(linked.starts_with("HTTP/1.1 404"));
    REQUIRE(linked.find("Content-Encoding: gzip")==std::string::npos);
    std::filesystem::remove(server.root/"asset.js.gz");
    auto plain=server.Get("/asset.js",true);REQUIRE(plain.starts_with("HTTP/1.1 200"));
    REQUIRE(plain.ends_with("plain asset"));REQUIRE(plain.find("Content-Encoding: gzip")==std::string::npos);
    server.Put("asset.js.gz","compressed asset");auto compressed=server.Get("/asset.js",true);
    REQUIRE(compressed.starts_with("HTTP/1.1 200"));REQUIRE(compressed.ends_with("compressed asset"));
    REQUIRE(compressed.find("Content-Encoding: gzip")!=std::string::npos);
    if(geteuid()!=0) {
        // Metadata succeeds, but opening the selected gzip file fails. A 404
        // body is plain HTML and must not inherit the successful gzip header.
        REQUIRE(chmod((server.root/"asset.js.gz").c_str(),0000)==0);
        auto unreadable=server.Get("/asset.js",true);REQUIRE(unreadable.starts_with("HTTP/1.1 404"));
        REQUIRE(unreadable.find("Content-Encoding: gzip")==std::string::npos);
    }
    auto healthy=server.Get("/");REQUIRE(healthy.starts_with("HTTP/1.1 200"));REQUIRE(healthy.ends_with("still running"));
}

TEST_CASE("WebServer shutdown", "[webServerShutdown][Build][Dev]")
{
    MemStats initialMemory = GetMemStats();
    {
        auto const address = boost::asio::ip::make_address("0.0.0.0");
        auto const port = 8081;
        std::string doc_root = ".";
        auto const threads = 3;

        auto server = WebServer::create(
            address, port, doc_root.c_str(), threads,512*1024*1024);
        server->RunInBackground();
        sleep(5);
        server->ShutDown(1000);
        sleep(1);
        server->Join();
    }
    MemStats finalMemory = GetMemStats();

    // currently leaking one allocation of 8 bytes. Acceptable.
    if (finalMemory.allocations > initialMemory.allocations+1) 
    {
        std::cout << "Leaked Allocations: " << (finalMemory.allocations- initialMemory.allocations) << std::endl;
        std::cout << "Leaked Memory: " << (finalMemory.allocated - initialMemory.allocated) << " bytes" << std::endl;

        REQUIRE(finalMemory.allocations == initialMemory.allocations);
    }

}

/** Ready means the independent HTTP body reader sees every binary byte.
 * @see docs/specs/tone3000-gig-rig/tone3000-gig-rig.md [DES-LIBRARY] [DES-SEC] [7.37]
 */
TEST_CASE("WebServer upload completion flushes every packet grouping", "[webServerUpload][Build]")
{
    struct TemporaryDirectory {
        std::filesystem::path path;
        TemporaryDirectory() {
            auto pattern = (std::filesystem::temp_directory_path() / "pipedal-upload-test-XXXXXX").string();
            std::vector<char> name(pattern.begin(), pattern.end()); name.push_back(0);
            auto directory = mkdtemp(name.data());
            if (!directory) throw std::runtime_error("Upload fixture creation failed");
            path = directory;
        }
        ~TemporaryDirectory() { std::error_code ignored; std::filesystem::remove_all(path, ignored); }
    } temporary;
    std::string body(2049, '\0');
    for (size_t i = 0; i < body.size(); ++i) body[i] = static_cast<char>(i % 256);
    const std::string header = "POST /var/uploadTone3000Preset?filename=fixture.t3kpreset HTTP/1.1\r\nHost: localhost\r\nContent-Length: "
        + std::to_string(body.size()) + "\r\nContent-Type: application/octet-stream\r\n\r\n";
    std::vector<std::string> chunks;
    bool complete = true;
    SECTION("Headers and complete body in one chunk") { chunks = {header + body}; }
    SECTION("Headers then complete body") { chunks = {header, body}; }
    SECTION("Split header ends with complete body") { chunks = {header.substr(0, 13), header.substr(13) + body}; }
    SECTION("Partial body then continuation") { chunks = {header + body.substr(0, 21), body.substr(21)}; }
    SECTION("One byte chunks") {
        for (char byte : header + body) chunks.emplace_back(1, byte);
    }
    SECTION("Trailing request bytes are not part of the body") { chunks = {header + body + "NEXT", "LATER"}; }
    SECTION("Incomplete body never becomes ready") { chunks = {header + body.substr(0, body.size() - 1)}; complete = false; }
    SECTION("Incomplete header never becomes ready") { chunks = {header.substr(0, header.size() - 1)}; complete = false; }
    SECTION("Temporary output failure never becomes ready") {
        std::ofstream file(temporary.path / "not-a-directory"); file << "existing"; file.close();
        temporary.path /= "not-a-directory";
        std::error_code error; bool inspected = false;
        const auto progress = pipedal::detail::ConsumeFileUploadForTest(temporary.path, {header + body}, error,
            [&](const auto&, auto&) { inspected = true; });
        REQUIRE(error); REQUIRE(progress.size() == 1); REQUIRE_FALSE(progress.back().second); REQUIRE_FALSE(inspected);
        temporary.path = temporary.path.parent_path();
        return;
    }
    bool inspected = false;
    std::filesystem::path uploadPath;
    std::error_code error;
    const auto progress = pipedal::detail::ConsumeFileUploadForTest(temporary.path, chunks, error,
        [&](const auto& path, std::istream& stream) {
            inspected = true; uploadPath = path;
            REQUIRE(std::filesystem::file_size(path) == body.size());
            const std::string actual((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
            REQUIRE(actual == body); REQUIRE_FALSE(stream.bad());
            std::ifstream independent(path, std::ios::binary);
            REQUIRE(independent.good());
            const std::string disk((std::istreambuf_iterator<char>(independent)), std::istreambuf_iterator<char>());
            REQUIRE(disk == body);
        });
    REQUIRE_FALSE(error); REQUIRE(progress.size() == chunks.size()); REQUIRE(inspected == complete);
    if (complete) {
        REQUIRE(progress.back().second);
        REQUIRE_FALSE(std::filesystem::exists(uploadPath)); // Parser-owned temporary cleanup.
        if (chunks.back() == "LATER") {
            REQUIRE(progress.front().first == header.size() + body.size()); REQUIRE(progress.back().first == 0);
        }
    } else REQUIRE_FALSE(progress.back().second);
    // Every completed request becomes ready only at the final required body byte.
    if (chunks.size() > 1 && chunks.back() != "LATER") {
        for (size_t i = 0; i + 1 < progress.size(); ++i) REQUIRE_FALSE(progress[i].second);
    }
}
