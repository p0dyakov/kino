#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <netdb.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <openssl/sha.h>
#include <string>
#include <thread>

#include "../vendor/httplib.h"
#include "../vendor/json.hpp"
#include "engine.hpp"
#include "transmux.hpp"

using nlohmann::json;

#ifdef __APPLE__
int runAppShell(int port);
#endif

static ks::Engine* g_engine = nullptr;
static httplib::Server* g_server = nullptr;

static void onSignal(int) {
    if (g_server) g_server->stop();
    if (g_engine) g_engine->stopAll();
    _exit(0);
}

static void setCors(httplib::Response& res) {
    res.set_header("Access-Control-Allow-Origin", "*");
    res.set_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set_header("Access-Control-Allow-Headers", "Content-Type, Range");
}

static std::string normHash(const std::string& h) {
    if (h.size() != 40) return {};
    std::string out = h;
    for (auto& c : out) {
        c = (char)tolower((unsigned char)c);
        if (!isxdigit((unsigned char)c)) return {};
    }
    return out;
}

static std::vector<std::string> trackersFrom(const json& body) {
    std::vector<std::string> trackers;
    auto it = body.find("sources");
    if (it == body.end() || !it->is_array()) return trackers;
    for (auto& src : *it) {
        if (!src.is_string()) continue;
        std::string s = src.get<std::string>();
        if (s.rfind("tracker:", 0) == 0) trackers.push_back(s.substr(8));
    }
    return trackers;
}

static std::string downloadId(const std::string& hash, const json& rec) {
    int fi = rec.value("fileIdx", -1);
    std::string query = rec.value("fileQuery", "");
    const auto handleInput = std::to_string(fi) + ":" + (fi >= 0 ? "" : query);
    unsigned char digest[SHA256_DIGEST_LENGTH];
    SHA256(reinterpret_cast<const unsigned char*>(handleInput.data()),
           handleInput.size(), digest);
    char hex[33];
    for (int i = 0; i < 16; ++i) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    return hash + "-" + std::string(hex, 32);
}

static std::vector<std::pair<int, std::string>> targetsFor(
    const json& manifest, const std::string& hash) {
    std::vector<std::pair<int, std::string>> out;
    for (auto& [id, rec] : manifest.items()) {
        if (!rec.is_object()) continue;
        if (normHash(rec.value("infoHash", "")) != hash) continue;
        out.emplace_back(rec.value("fileIdx", -1), rec.value("fileQuery", ""));
    }
    return out;
}

static std::mutex g_dlMtx;
static json g_downloads = json::object();

static std::string manifestPath(ks::Engine& engine) {
    return engine.cacheDir() + "/downloads.json";
}

static bool writeManifest(const std::string& path, const json& cand) {
    std::string tmp = path + ".tmp";
    {
        std::ofstream of(tmp, std::ios::binary | std::ios::trunc);
        if (!of) return false;
        of << cand.dump(2);
        of.flush();
        if (!of) return false;
        of.close();
        if (!of) return false;
    }
    return ::rename(tmp.c_str(), path.c_str()) == 0;
}

static void revealPath(const std::string& path, httplib::Response& res) {
    if (path.empty()) {
        res.status = 404;
        res.set_content("{}", "application/json");
        return;
    }
    if (fork() == 0) {
        execlp("/usr/bin/open", "open", "-R", path.c_str(), (char*)nullptr);
        _exit(1);
    }
    res.set_content(json({{"ok", true}}).dump(), "application/json");
}



#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif

// bring up the local xray socks proxy (torrent-allowed NL exit) if it isn't
// running yet — probe 127.0.0.1:12080, spawn `xray run -c <cfg>` when closed
static void ensureTorrentProxy() {
    {
        addrinfo hints{}, *res = nullptr;
        hints.ai_socktype = SOCK_STREAM;
        if (getaddrinfo("127.0.0.1", "12080", &hints, &res) == 0) {
            int fd = ::socket(res->ai_family, res->ai_socktype, res->ai_protocol);
            if (fd >= 0) {
                timeval tv{0, 300000};
                setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
                if (::connect(fd, res->ai_addr, res->ai_addrlen) == 0) {
                    ::close(fd); freeaddrinfo(res); return; // already up
                }
                ::close(fd);
            }
            freeaddrinfo(res);
        }
    }

    // locate xray binary + config
    const char* xrayBins[] = {"/opt/homebrew/bin/xray", "/usr/local/bin/xray", getenv("KS_XRAY_BIN")};
    std::string bin;
    for (auto* b : xrayBins)
        if (b && ::access(b, X_OK) == 0) { bin = b; break; }

    std::string exeDir;
#ifdef __APPLE__
    char exePath[4096]; uint32_t sz = sizeof exePath;
    if (_NSGetExecutablePath(exePath, &sz) == 0) {
        exeDir = exePath;
        exeDir = exeDir.substr(0, exeDir.find_last_of('/'));
    }
#endif
    std::string cfg;
    for (const std::string& cand : {
            std::string(getenv("KS_XRAY_CONFIG") ? getenv("KS_XRAY_CONFIG") : ""),
            exeDir + "/../Resources/xray-torrent.json",
            exeDir + "/xray-torrent.json",
            std::string("xray-torrent.json"),
            std::string("engine/xray-torrent.json")})
        if (!cand.empty() && ::access(cand.c_str(), R_OK) == 0) { cfg = cand; break; }

    if (bin.empty() || cfg.empty()) {
        fprintf(stderr, "ksengine: xray not found, torrent traffic unproxied\n");
        return;
    }
    pid_t pid = fork();
    if (pid == 0) {
        int dn = ::open("/dev/null", O_RDWR);
        dup2(dn, 1); dup2(dn, 2);
        execl(bin.c_str(), "xray", "run", "-c", cfg.c_str(), (char*)nullptr);
        _exit(127);
    }
    // wait for the socks port to accept
    for (int i = 0; i < 40; i++) {
        usleep(100000);
        addrinfo hints{}, *res = nullptr;
        hints.ai_socktype = SOCK_STREAM;
        if (getaddrinfo("127.0.0.1", "12080", &hints, &res) != 0) continue;
        int fd = ::socket(res->ai_family, res->ai_socktype, res->ai_protocol);
        if (fd >= 0) {
            timeval tv{0, 200000};
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
            if (::connect(fd, res->ai_addr, res->ai_addrlen) == 0) {
                ::close(fd); freeaddrinfo(res);
                fprintf(stderr, "ksengine: xray up (pid %d)\n", (int)pid);
                return;
            }
            ::close(fd);
        }
        freeaddrinfo(res);
    }
    fprintf(stderr, "ksengine: xray spawn timed out\n");
}

int main(int argc, char** argv) {
    std::string uiDir = "ui";
    std::string host = "127.0.0.1";
    int port = 0;
    bool appMode = false;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--ui" && i + 1 < argc) uiDir = argv[++i];
        else if (a == "--host" && i + 1 < argc) host = argv[++i];
        else if (a == "--port" && i + 1 < argc) port = atoi(argv[++i]);
        else if (a == "--app") appMode = true;
        else if (a == "--help") {
            fprintf(stderr, "ksengine [--ui DIR] [--host H] [--port N] [--app]\n");
            return 0;
        }
    }

    ks::Engine engine;
    engine.spawnProxy_ = ensureTorrentProxy; // lazy: spawned on first stall
    g_engine = &engine;
    httplib::Server svr;
    g_server = &svr;

    {
        std::ifstream in(manifestPath(engine), std::ios::binary);
        if (in) {
            try {
                auto parsed = json::parse(in);
                if (parsed.is_object()) {
                    for (auto& [k, v] : parsed.items()) {
                        try {
                            if (!v.is_object()) continue;
                            const auto hash = normHash(v.value("infoHash", k));
                            if (hash.empty()) continue;
                            v["infoHash"] = hash;
                            g_downloads[downloadId(hash, v)] = v;
                        } catch (...) {}
                    }
                }
            } catch (...) {}
        }
        std::unordered_map<std::string, std::shared_ptr<ks::StreamSession>> restored;
        for (auto& [id, rec] : g_downloads.items()) {
            const auto hash = normHash(rec.value("infoHash", ""));
            if (hash.empty()) continue;
            auto s = engine.addTorrent(hash, trackersFrom(rec),
                rec.value("title", ""), rec.value("fileIdx", -1), true,
                rec.value("fileQuery", ""));
            if (s && s->handle.is_valid()) restored[hash] = s;
        }
        for (auto& [hash, s] : restored)
            engine.setDownloadTargets(s, targetsFor(g_downloads, hash));
    }

    signal(SIGINT, onSignal);
    signal(SIGTERM, onSignal);
    signal(SIGPIPE, SIG_IGN);

    svr.set_pre_routing_handler([](const httplib::Request&, httplib::Response& res) {
        setCors(res);
        return httplib::Server::HandlerResponse::Unhandled;
    });

    // ---------- API ----------

    svr.Options("/api/.*", [](const httplib::Request&, httplib::Response&) {});

    svr.Get("/api/health", [&](const httplib::Request&, httplib::Response& res) {
        json j = {{"ok", true}};
        json arr = json::array();
        for (auto& id : engine.sessionIds()) arr.push_back(id);
        j["sessions"] = arr;
        res.set_content(j.dump(), "application/json");
    });

    // diag sink: the watch page posts the live video-element state so seeks
    // can be debugged without going through the AX tree
    static std::string g_playerDebug;
    static std::mutex g_playerDebugMtx;
    svr.Post("/api/playerdebug", [&](const httplib::Request& req, httplib::Response& res) {
        if (req.body.size() > 32 * 1024) {
            res.status = 413;
            res.set_content("{}", "application/json");
            return;
        }
        { std::lock_guard<std::mutex> lk(g_playerDebugMtx); g_playerDebug = req.body; }
        res.set_content("{}", "application/json");
    });
    svr.Get("/api/playerdebug", [&](const httplib::Request&, httplib::Response& res) {
        std::lock_guard<std::mutex> lk(g_playerDebugMtx);
        res.set_content(g_playerDebug.empty() ? "{}" : g_playerDebug, "application/json");
    });

    svr.Post("/api/play", [&](const httplib::Request& req, httplib::Response& res) {
        json body;
        try { body = json::parse(req.body); }
        catch (...) {
            res.status = 400;
            res.set_content(json({{"ok", false}, {"error", "bad json"}}).dump(), "application/json");
            return;
        }
        std::string infoHash = normHash(body.value("infoHash", ""));
        if (infoHash.empty()) {
            res.status = 400;
            res.set_content(json({{"ok", false}, {"error", "infoHash required"}}).dump(), "application/json");
            return;
        }
        std::vector<std::string> trackers = trackersFrom(body);
        std::string title = body.value("title", "");
        int fileIdx = body.value("fileIdx", -1);

        auto s = engine.addTorrent(infoHash, trackers, title, fileIdx,
            /*isDownload*/ false, body.value("fileQuery", ""));
        if (!s || !s->handle.is_valid()) {
            res.status = 400;
            res.set_content(json({{"ok", false},
                {"error", s && !s->error.empty() ? s->error : "failed to add torrent"}}).dump(),
                "application/json");
            return;
        }
        res.set_content(json({
            {"ok", true}, {"id", s->id},
            {"status", "/api/session/" + s->id},
            {"stream", "/stream/" + s->id},
        }).dump(), "application/json");
    });

    // background download — survives new play sessions; same body as /api/play
    svr.Post("/api/download", [&](const httplib::Request& req, httplib::Response& res) {
        json body;
        try { body = json::parse(req.body); }
        catch (...) {
            res.status = 400;
            res.set_content(json({{"ok", false}, {"error", "bad json"}}).dump(), "application/json");
            return;
        }
        std::string infoHash = normHash(body.value("infoHash", ""));
        if (infoHash.empty()) {
            res.status = 400;
            res.set_content(json({{"ok", false}, {"error", "infoHash required"}}).dump(), "application/json");
            return;
        }
        auto s = engine.addTorrent(infoHash, trackersFrom(body),
            body.value("title", ""), body.value("fileIdx", -1), /*isDownload*/ true,
            body.value("fileQuery", ""));
        if (!s || !s->handle.is_valid()) {
            res.set_content(json({{"ok", false},
                {"error", s && !s->error.empty() ? s->error : "failed to add torrent"}}).dump(),
                "application/json");
            return;
        }
        {
            std::lock_guard<std::mutex> lk(g_dlMtx);
            json cand = g_downloads;
            json rec;
            rec["infoHash"] = infoHash;
            rec["fileIdx"] = body.value("fileIdx", -1);
            rec["title"] = body.value("title", "");
            rec["fileQuery"] = body.value("fileQuery", "");
            if (body.contains("sources") && body["sources"].is_array())
                rec["sources"] = body["sources"];
            else
                rec["sources"] = json::array();
            for (const char* k : {"mid", "mt", "ep"})
                if (body.contains(k)) rec[k] = body[k];
            cand[downloadId(infoHash, rec)] = rec;
            if (!writeManifest(manifestPath(engine), cand)) {
                res.set_content(json({{"ok", false},
                    {"error", "cannot persist manifest"}}).dump(), "application/json");
                return;
            }
            g_downloads = std::move(cand);
            engine.setDownloadTargets(s, targetsFor(g_downloads, infoHash));
        }
        res.set_content(json({{"ok", true}, {"id", s->id}}).dump(), "application/json");
    });

    svr.Get("/api/downloads", [&](const httplib::Request&, httplib::Response& res) {
        json copy;
        { std::lock_guard<std::mutex> lk(g_dlMtx); copy = g_downloads; }
        json arr = json::array();
        for (auto& [id, rec] : copy.items()) {
            const auto hash = normHash(rec.value("infoHash", ""));
            auto s = hash.empty() ? std::shared_ptr<ks::StreamSession>()
                                 : engine.get(hash);
            const int rIdx = rec.value("fileIdx", -1);
            const std::string rQ = rec.value("fileQuery", "");
            auto st = json::parse(engine.targetStatusJson(s, rIdx, rQ,
                rIdx >= 0 || !rQ.empty()), nullptr, false);
            if (!st.is_object()) st = json::object();
            st["id"] = id;
            for (const char* k : {"title", "mid", "mt", "ep"})
                if (rec.contains(k)) st[k] = rec[k];
            arr.push_back(std::move(st));
        }
        res.set_content(arr.dump(), "application/json");
    });

    svr.Post(R"(/api/downloads/([a-zA-Z0-9-]+)/play)", [&](const httplib::Request& req, httplib::Response& res) {
        json rec;
        {
            std::lock_guard<std::mutex> lk(g_dlMtx);
            auto it = g_downloads.find(req.matches[1]);
            if (it != g_downloads.end()) rec = *it;
        }
        const auto hash = rec.is_object() ? normHash(rec.value("infoHash", "")) : std::string{};
        if (hash.empty() || !rec.is_object()) {
            res.status = 404;
            res.set_content(json({{"ok", false}, {"error", "unknown download"}}).dump(), "application/json");
            return;
        }
        const int requestedIdx = rec.value("fileIdx", -1);
        const std::string requestedQuery = rec.value("fileQuery", "");
        auto status = json::parse(engine.targetStatusJson(engine.get(hash),
            requestedIdx, requestedQuery,
            requestedIdx >= 0 || !requestedQuery.empty()), nullptr, false);
        if (!status.is_object() || !status.value("ready", false)) {
            res.status = 409;
            res.set_content(json({{"ok", false}, {"error", "download not ready"}}).dump(), "application/json");
            return;
        }
        auto s = engine.addTorrent(hash, trackersFrom(rec),
            rec.value("title", ""), status.value("fileIdx", requestedIdx),
            /*isDownload*/ false, "");
        if (!s || !s->handle.is_valid()) {
            res.status = 400;
            res.set_content(json({{"ok", false}, {"error", "failed to add torrent"}}).dump(), "application/json");
            return;
        }
        json out = {{"ok", true}, {"id", s->id}};
        for (const char* k : {"mid", "mt", "ep", "title", "fileQuery"})
            if (rec.contains(k)) out[k] = rec[k];
        out["fileIdx"] = (s->metadataReady && s->fileIndex >= 0)
            ? s->fileIndex : rec.value("fileIdx", -1);
        res.set_content(out.dump(), "application/json");
    });

    svr.Post(R"(/api/downloads/([a-zA-Z0-9-]+)/reveal)", [&](const httplib::Request& req, httplib::Response& res) {
        json rec;
        {
            std::lock_guard<std::mutex> lk(g_dlMtx);
            auto it = g_downloads.find(req.matches[1]);
            if (it != g_downloads.end()) rec = *it;
        }
        const auto hash = rec.is_object() ? normHash(rec.value("infoHash", "")) : std::string{};
        if (hash.empty() || !rec.is_object()) {
            res.status = 404;
            res.set_content("{}", "application/json");
            return;
        }
        const int rIdx = rec.value("fileIdx", -1);
        const std::string rQ = rec.value("fileQuery", "");
        auto st = json::parse(engine.targetStatusJson(engine.get(hash),
            rIdx, rQ, rIdx >= 0 || !rQ.empty()), nullptr, false);
        revealPath(st.is_object() ? st.value("filePath", "") : "", res);
    });

    svr.Delete(R"(/api/downloads/([a-zA-Z0-9-]+))", [&](const httplib::Request& req, httplib::Response& res) {
        std::string hash;
        {
            std::lock_guard<std::mutex> lk(g_dlMtx);
            auto it = g_downloads.find(req.matches[1]);
            if (it == g_downloads.end()) {
                res.status = 404;
                res.set_content(json({{"ok", false}, {"error", "unknown download"}}).dump(), "application/json");
                return;
            }
            hash = normHash(it->value("infoHash", ""));
            json cand = g_downloads;
            cand.erase(req.matches[1]);
            if (!writeManifest(manifestPath(engine), cand)) {
                res.status = 500;
                res.set_content(json({{"ok", false},
                    {"error", "cannot persist manifest"}}).dump(), "application/json");
                return;
            }
            g_downloads = std::move(cand);
            if (auto s = hash.empty() ? std::shared_ptr<ks::StreamSession>()
                                    : engine.get(hash)) {
                auto remaining = targetsFor(g_downloads, hash);
                engine.setDownloadTargets(s, remaining);
                if (remaining.empty() && s->isDownload) engine.stop(hash);
            }
        }
        res.set_content(json({{"ok", true}}).dump(), "application/json");
    });

    svr.Post("/api/prefetch", [&](const httplib::Request& req, httplib::Response& res) {
        json body;
        try { body = json::parse(req.body); }
        catch (...) {
            res.status = 400;
            res.set_content(json({{"ok", false}, {"error", "bad json"}}).dump(), "application/json");
            return;
        }
        std::string infoHash = normHash(body.value("infoHash", ""));
        if (infoHash.empty()) {
            res.status = 400;
            res.set_content(json({{"ok", false}, {"error", "infoHash required"}}).dump(), "application/json");
            return;
        }
        auto s = engine.addTorrent(infoHash, trackersFrom(body),
            body.value("title", ""), body.value("fileIdx", -1),
            /*isDownload*/ false, body.value("fileQuery", ""), /*warmOnly*/ true);
        res.set_content(json({{"ok", s && s->handle.is_valid()},
            {"id", s ? s->id : ""}}).dump(), "application/json");
    });

    svr.Get(R"(/api/prefetch/([a-zA-Z0-9]+))", [&](const httplib::Request& req, httplib::Response& res) {
        std::string hash = normHash(req.matches[1]);
        auto s = hash.empty() ? std::shared_ptr<ks::StreamSession>()
                             : engine.get(hash);
        int fi = req.has_param("fi") ? atoi(req.get_param_value("fi").c_str()) : -1;
        std::string q = req.has_param("q") ? req.get_param_value("q") : "";
        res.set_content(engine.targetStatusJson(s, fi, q,
            fi >= 0 || !q.empty()), "application/json");
    });

    // show the downloaded file in Finder
    svr.Post(R"(/api/session/([a-zA-Z0-9]+)/reveal)", [&](const httplib::Request& req, httplib::Response& res) {
        auto s = engine.get(req.matches[1]);
        revealPath((s && !s->filePathOnDisk.empty()) ? s->filePathOnDisk : "", res);
    });

    svr.Get(R"(/api/session/([a-zA-Z0-9]+))", [&](const httplib::Request& req, httplib::Response& res) {
        auto s = engine.get(req.matches[1]);
        if (!s) { res.status = 404; res.set_content("{}", "application/json"); return; }
        res.set_content(engine.statusJson(s), "application/json");
    });

    svr.Get(R"(/api/session/([a-zA-Z0-9]+)/files)", [&](const httplib::Request& req, httplib::Response& res) {
        auto s = engine.get(req.matches[1]);
        if (!s || !s->metadataReady) { res.status = 404; res.set_content("[]", "application/json"); return; }
        json arr = json::array();
        for (auto& f : engine.files(s))
            arr.push_back({{"index", f.index}, {"path", f.path}, {"size", f.size}, {"selected", f.selected}});
        res.set_content(arr.dump(), "application/json");
    });

    svr.Delete(R"(/api/session/([a-zA-Z0-9]+))", [&](const httplib::Request& req, httplib::Response& res) {
        engine.stop(req.matches[1]);
        res.set_content(json({{"ok", true}}).dump(), "application/json");
    });

    svr.Get(R"(/api/session/([a-zA-Z0-9]+)/tracks)", [&](const httplib::Request& req, httplib::Response& res) {
        auto s = engine.get(req.matches[1]);
        if (!s) { res.status = 404; res.set_content("{}", "application/json"); return; }
        if (!s->metadataReady) engine.waitMetadata(s, 60);
        if (!s->metadataReady) { res.status = 504; res.set_content("{}", "application/json"); return; }
        auto tx = engine.transmuxer(s);
        if (!tx->open()) {
            res.status = 500;
            res.set_content(json({{"error", "probe failed"}}).dump(), "application/json");
            return;
        }
        auto tj = tx->tracks();
        tj["fileIdx"] = s->fileIndex;
        res.set_content(tj.dump(), "application/json");
    });

    // fragmented MP4 for the embedded MSE player
    svr.Get(R"(/fmp4/([a-zA-Z0-9]+))", [&](const httplib::Request& req, httplib::Response& res) {
        auto s = engine.get(req.matches[1]);
        if (!s) { res.status = 404; return; }
        if (!s->metadataReady) engine.waitMetadata(s, 60);
        if (!s->metadataReady) { res.status = 504; return; }
        auto tx = engine.transmuxer(s);
        if (!tx->open()) { res.status = 500; res.set_content("probe failed", "text/plain"); return; }

        double t = 0;
        int audio = -1;
        if (req.has_param("t")) t = atof(req.get_param_value("t").c_str());
        if (req.has_param("audio")) audio = atoi(req.get_param_value("audio").c_str());

        // a new request cancels the producer already streaming on this session
        engine.cancelTransmux(s->id);

        res.set_header("Accept-Ranges", "none");
        res.set_content_provider("video/mp4",
            [tx, t, audio](size_t offset, httplib::DataSink& sink) -> bool {
                if (offset > 0) return false; // produce() streamed everything already
                tx->produce(t, audio,
                    [&sink](const char* buf, size_t n) { return sink.write(buf, n); });
                return false;
            });
    });

    // ---------- streaming ----------
    // httplib handles Range parsing/206/416 automatically when the
    // provider is registered with the full file length.

    svr.Get(R"(/stream/([a-zA-Z0-9]+))", [&](const httplib::Request& req, httplib::Response& res) {
        auto s = engine.get(req.matches[1]);
        if (!s) { res.status = 404; return; }
        if (!s->metadataReady) engine.waitMetadata(s, 60);
        if (!s->metadataReady) { res.status = 504; return; }

        res.set_header("Accept-Ranges", "bytes");
        res.set_content_provider((size_t)s->fileSize, s->mime.c_str(),
            [&engine, s](size_t offset, size_t want, httplib::DataSink& sink) {
                return engine.readRange(s, (int64_t)offset, (int64_t)want,
                    [&sink](const char* buf, size_t n) { return sink.write(buf, n); });
            });
    });

    // ---------- static UI + SPA fallback ----------

    // Pages exist as both "page.html" and "page/" (RSC payload dir) in the
    // export — the mount point 301s "/page" -> "/page/" and drops the query
    // string, and it runs before GET handlers, so intercept in pre-routing.
    svr.set_pre_routing_handler([&](const httplib::Request& req, httplib::Response& res) {
        if (req.method != "GET") return httplib::Server::HandlerResponse::Unhandled;
        std::string p = req.path;
        if (p.size() > 1 && p.back() == '/') p.pop_back();
        static const std::set<std::string> pages = {"/movie", "/browse", "/search", "/library", "/watch"};
        if (!pages.count(p)) return httplib::Server::HandlerResponse::Unhandled;
        std::ifstream in(uiDir + p + ".html", std::ios::binary);
        if (!in) return httplib::Server::HandlerResponse::Unhandled;
        res.set_content(std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>()), "text/html");
        return httplib::Server::HandlerResponse::Handled;
    });

    svr.set_error_handler([&](const httplib::Request& req, httplib::Response& res) {
        if (req.method != "GET" || res.status != 404) return;
        std::string path = req.path;
        if (path.rfind("/api/", 0) == 0 || path.rfind("/stream/", 0) == 0 || path.rfind("/fmp4/", 0) == 0) return;
        if (path.find('.') != std::string::npos) return;
        // try exported page "<path>.html", else index.html
        std::string file = uiDir + (path == "/" ? "/index.html" : path + ".html");
        if (path == "/") file = uiDir + "/index.html";
        if (!httplib::detail::FileStat(file).is_file()) file = uiDir + "/index.html";
        std::ifstream in(file, std::ios::binary);
        if (!in) { res.status = 404; res.set_content("ui not found", "text/plain"); return; }
        std::string body((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        res.status = 200;
        res.set_content(std::move(body), "text/html");
    });
    svr.set_mount_point("/", uiDir);

    // ---------- bind & run ----------

    if (port == 0) {
        port = svr.bind_to_any_port(host);
    } else if (!svr.bind_to_port(host, port)) {
        port = -1;
    }
    if (port <= 0) {
        fprintf(stderr, "ksengine: failed to bind %s:%d\n", host.c_str(), port);
        return 1;
    }
    engine.setPort(port);
    printf("ksengine: http://%s:%d (ui=%s)\n", host.c_str(), port, uiDir.c_str());
    fflush(stdout);

#ifdef __APPLE__
    if (appMode) {
        std::thread([&] { svr.listen_after_bind(); }).detach();
        return runAppShell(port); // blocks; engine stops on app quit
    }
#endif
    svr.listen_after_bind();
    return 0;
}
