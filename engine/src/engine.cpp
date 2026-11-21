#include "engine.hpp"
#include "peerrelay.hpp"
#include "transmux.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <regex>
#include <fcntl.h>
#include <unistd.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/stat.h>

#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/alert_types.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/read_resume_data.hpp>
#include <libtorrent/session_params.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/bdecode.hpp>
#include <libtorrent/span.hpp>
#include <libtorrent/torrent_status.hpp>
#include <libtorrent/write_resume_data.hpp>

#include "../vendor/json.hpp"
#include "../vendor/httplib.h"

namespace ks {

using nlohmann::json;
using namespace std::chrono_literals;

namespace {
constexpr int64_t kAheadBytes = 96 * 1024 * 1024;   // readahead window
constexpr int64_t kBehindBytes = 8 * 1024 * 1024;   // keep behind playhead
constexpr int64_t kMarginBytes = 32 * 1024 * 1024;  // prefetch margin around window
constexpr int64_t kHeadBytes = 12 * 1024 * 1024;    // priority head (moov/headers)
constexpr int64_t kTailBytes = 2 * 1024 * 1024;     // priority tail (cues)
constexpr int kStallTimeoutSec = 45;

std::string hexEncode(const uint8_t* p, size_t n) {
    static const char* h = "0123456789abcdef";
    std::string out;
    out.reserve(n * 2);
    for (size_t i = 0; i < n; ++i) {
        out.push_back(h[p[i] >> 4]);
        out.push_back(h[p[i] & 0xf]);
    }
    return out;
}

std::string infoHashHex(const lt::info_hash_t& ih) {
    if (ih.has_v1()) return hexEncode(reinterpret_cast<const uint8_t*>(ih.v1.data()), 20);
    if (ih.has_v2()) return hexEncode(reinterpret_cast<const uint8_t*>(ih.v2.data()), 32);
    return {};
}

std::vector<uint8_t> hexToBytes(const std::string& h) {
    std::vector<uint8_t> out;
    out.reserve(h.size() / 2);
    for (size_t i = 0; i + 1 < h.size(); i += 2)
        out.push_back((uint8_t)strtoul(h.substr(i, 2).c_str(), nullptr, 16));
    return out;
}

using Peer = std::pair<std::string, uint16_t>;

// udp tracker announce over an UNBOUND socket — the packet rides the
// default route through the VPN tunnel, which relays tracker udp fine.
// (udp from sockets bound to en0 is dropped outbound by the isp.)
std::vector<Peer> udpAnnounce(const std::string& host, uint16_t port,
                              const std::vector<uint8_t>& infoHash,
                              const std::vector<uint8_t>& peerId) {
    addrinfo hints{}, *res = nullptr;
    hints.ai_socktype = SOCK_DGRAM;
    hints.ai_family = AF_INET;
    if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0 || !res)
        return {};
    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) { freeaddrinfo(res); return {}; }
    timeval tv{4, 0};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    if (::connect(fd, res->ai_addr, res->ai_addrlen) != 0) {
        ::close(fd); freeaddrinfo(res); return {};
    }
    freeaddrinfo(res);

    auto put32 = [](std::vector<uint8_t>& v, uint32_t x) {
        v.push_back(x >> 24); v.push_back(x >> 16); v.push_back(x >> 8); v.push_back(x);
    };
    auto put64 = [&](std::vector<uint8_t>& v, uint64_t x) { put32(v, x >> 32); put32(v, (uint32_t)x); };

    uint32_t txn = (uint32_t)arc4random();
    std::vector<uint8_t> pkt;
    put64(pkt, 0x41727101980ULL); put32(pkt, 0); put32(pkt, txn);
    if (::send(fd, pkt.data(), pkt.size(), 0) < 0) { ::close(fd); return {}; }
    uint8_t buf[65536];
    ssize_t n = ::recv(fd, buf, sizeof buf, 0);
    if (n < 16) { ::close(fd); return {}; }
    uint64_t connId = 0;
    for (int i = 8; i < 16; ++i) connId = (connId << 8) | buf[i];

    pkt.clear();
    put64(pkt, connId); put32(pkt, 1); put32(pkt, txn);
    pkt.insert(pkt.end(), infoHash.begin(), infoHash.end());
    pkt.insert(pkt.end(), peerId.begin(), peerId.end());
    put64(pkt, 0); put64(pkt, 1ULL << 40); put64(pkt, 0); // down/left/up
    put32(pkt, 2); put32(pkt, 0); put32(pkt, arc4random()); // started, ip, key
    put32(pkt, 200); pkt.push_back(0); pkt.push_back(0); pkt.push_back(0x1a); pkt.push_back(0xe1); // numwant, port 6881
    if (::send(fd, pkt.data(), pkt.size(), 0) < 0) { ::close(fd); return {}; }
    n = ::recv(fd, buf, sizeof buf, 0);
    ::close(fd);
    if (n < 20) return {};

    std::vector<Peer> peers;
    for (ssize_t i = 20; i + 6 <= n; i += 6) {
        char ip[16];
        snprintf(ip, sizeof ip, "%u.%u.%u.%u", buf[i], buf[i+1], buf[i+2], buf[i+3]);
        uint16_t p = (buf[i+4] << 8) | buf[i+5];
        if (p) peers.emplace_back(ip, p);
    }
    return peers;
}

// http(s) announce over an unbound socket — the relayed path is fine for
// plain http; responses are bencoded, peers compact by default
std::vector<Peer> httpAnnounce(const std::string& url,
                               const std::vector<uint8_t>& infoHash,
                               const std::vector<uint8_t>& peerId) {
    auto enc = [](const std::vector<uint8_t>& b) {
        std::string s;
        char tmp[4];
        for (uint8_t c : b) { snprintf(tmp, 4, "%%%02X", c); s += tmp; }
        return s;
    };
    auto sep = url.find("://");
    if (sep == std::string::npos) return {};
    std::string scheme = url.substr(0, sep);
    std::string rest = url.substr(sep + 3);
    auto slash = rest.find('/');
    std::string hostport = slash == std::string::npos ? rest : rest.substr(0, slash);
    std::string base = slash == std::string::npos ? "/announce" : rest.substr(slash);
    base += (base.find('?') == std::string::npos ? "?" : "&");
    base += "info_hash=" + enc(infoHash) + "&peer_id=" + enc(peerId)
          + "&port=6881&uploaded=0&downloaded=0&left=1099511627776&compact=1&event=started&numwant=200";

    // the local xray http proxy is the preferred path: its near leg is
    // loopback (immune to vpn flaps) and the far leg rides the vless exit,
    // while the isp edge drops tracker http on the physical interface
    std::string body;
    auto get = [&](auto& cli) {
        cli.set_connection_timeout(3, 0); cli.set_read_timeout(5, 0);
        if (auto r = cli.Get(base.c_str()); r && r->status == 200)
            body = std::move(r->body);
    };
    if (scheme == "https") {
        httplib::SSLClient cli(hostport);
        cli.set_proxy("127.0.0.1", 12081);
        get(cli);
        if (body.empty()) { httplib::SSLClient direct(hostport); get(direct); }
    } else {
        httplib::Client cli(hostport);
        cli.set_proxy("127.0.0.1", 12081);
        get(cli);
        if (body.empty()) { httplib::Client direct(hostport); get(direct); }
    }
    if (body.empty()) return {};

    // find "peers" — expect a compact binary string
    auto pos = body.find("5:peers");
    if (pos == std::string::npos) return {};
    size_t i = pos + 7;
    if (!isdigit((unsigned char)body[i])) return {};
    size_t len = 0;
    while (i < body.size() && isdigit((unsigned char)body[i]))
        len = len * 10 + (body[i++] - '0');
    if (i >= body.size() || body[i] != ':') return {};
    ++i;
    std::vector<Peer> peers;
    for (size_t k = i; k + 6 <= body.size() && k + 6 <= i + len; k += 6) {
        const uint8_t* p = reinterpret_cast<const uint8_t*>(body.data() + k);
        char ip[16];
        snprintf(ip, sizeof ip, "%u.%u.%u.%u", p[0], p[1], p[2], p[3]);
        uint16_t port = (p[4] << 8) | p[5];
        if (port) peers.emplace_back(ip, port);
    }
    return peers;
}

// .torrent mirrors over plain https — peers are not needed for metadata
// at all when one of these has the file cached (usual case for popular swarms)
constexpr const char* kMirrors[] = {
    "https://itorrents.org/torrent/%s.torrent",
    "https://btcache.me/torrent/%s",
    "https://torrage.lyncrust.com/torrent/%s",
};

std::vector<char> fetchTorrentFile(const std::string& infoHash, const char* fmt) {
    std::string upper = infoHash;
    for (auto& c : upper) c = (char)toupper((unsigned char)c);
    char url[256];
    snprintf(url, sizeof url, fmt, upper.c_str());
    std::string u = url;
    auto scheme = u.find("://");
    auto slash = u.find('/', scheme + 3);
    std::string host = u.substr(scheme + 3, slash - scheme - 3);
    std::string path = u.substr(slash);
    httplib::SSLClient cli(host);
    cli.set_connection_timeout(2, 0);
    cli.set_read_timeout(4, 0);
    cli.set_follow_location(true);
    auto res = cli.Get(path.c_str());
    if (res && res->status == 200 && res->body.size() > 100 && res->body.front() == 'd') {
        fprintf(stderr, "ksengine: torrent file %s (%zuB) via %s\n",
                infoHash.c_str(), res->body.size(), host.c_str());
        return {res->body.begin(), res->body.end()};
    }
    fprintf(stderr, "ksengine: torrent mirror %s fail: %s\n",
            host.c_str(),
            res ? std::to_string(res->status).c_str()
                : httplib::to_string(res.error()).c_str());
    return {};
}

bool isVideoPath(const std::string& p) {
    static const char* exts[] = {".mkv", ".mp4", ".avi", ".m4v", ".mov",
                                 ".ts", ".m2ts", ".wmv", ".webm", ".mpg", ".mpeg"};
    if (p.size() < 4) return false;
    std::string lower = p;
    std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
    for (auto* e : exts) if (lower.size() >= strlen(e) && lower.compare(lower.size() - strlen(e), std::string::npos, e) == 0) return true;
    return false;
}

const char* mimeFor(const std::string& path) {
    std::string l = path;
    std::transform(l.begin(), l.end(), l.begin(), ::tolower);
    auto has = [&](const char* e) { return l.size() >= strlen(e) && l.compare(l.size() - strlen(e), std::string::npos, e) == 0; };
    if (has(".mkv")) return "video/x-matroska";
    if (has(".mp4") || has(".m4v")) return "video/mp4";
    if (has(".avi")) return "video/x-msvideo";
    if (has(".mov")) return "video/quicktime";
    if (has(".webm")) return "video/webm";
    if (has(".ts") || has(".m2ts")) return "video/mp2t";
    if (has(".wmv")) return "video/x-ms-wmv";
    return "application/octet-stream";
}

int64_t nowUs() {
    return std::chrono::duration_cast<std::chrono::microseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
} // namespace

static lt::settings_pack makeSettings() {
    lt::settings_pack pack;
    // aggressive peer acquisition for fast start
    pack.set_int(lt::settings_pack::connections_limit, 800);
    pack.set_int(lt::settings_pack::connection_speed, 100);
    pack.set_int(lt::settings_pack::torrent_connect_boost, 200);
    pack.set_int(lt::settings_pack::max_peerlist_size, 8000);
    pack.set_int(lt::settings_pack::active_limit, 100);
    pack.set_int(lt::settings_pack::active_downloads, -1);
    pack.set_int(lt::settings_pack::unchoke_slots_limit, 16);
    // fast re-request on failure
    pack.set_int(lt::settings_pack::request_timeout, 12);
    pack.set_int(lt::settings_pack::piece_timeout, 8);
    pack.set_int(lt::settings_pack::peer_timeout, 45);
    // give up on dead peers fast → more dials per minute during ramp-up
    pack.set_int(lt::settings_pack::peer_connect_timeout, 10);
    pack.set_int(lt::settings_pack::inactivity_timeout, 30);
    // swarm discovery
    pack.set_bool(lt::settings_pack::enable_dht, true);
    pack.set_bool(lt::settings_pack::enable_lsd, true);
    pack.set_bool(lt::settings_pack::enable_upnp, true);
    pack.set_bool(lt::settings_pack::enable_natpmp, true);
    pack.set_bool(lt::settings_pack::announce_to_all_tiers, true);
    pack.set_bool(lt::settings_pack::announce_to_all_trackers, true);
    // we only stream — uploads kept low but non-zero to stay unchoked
    pack.set_int(lt::settings_pack::upload_rate_limit, 1024 * 1024);
    // disk: OS page cache + mmap io does the rest
    pack.set_int(lt::settings_pack::aio_threads, 16);
    pack.set_int(lt::settings_pack::alert_queue_size, 8192);

    // transport map on this machine: outbound TCP is transparently
    // intercepted by the vpn relay (dead for p2p ports), and udp bound to
    // the physical nic is dropped by the isp — but unbound udp rides the
    // tunnel's relay and reaches everything. so peers go over uTP on the
    // default-route udp socket.
    // NOTE: every relay-wrapped peer is 127.0.0.1 on a distinct port —
    // without multiple-per-ip libtorrent collapses the whole relay pool
    // to a single connection.
    pack.set_bool(lt::settings_pack::allow_multiple_connections_per_ip, true);
    pack.set_bool(lt::settings_pack::enable_outgoing_utp, true);
    pack.set_bool(lt::settings_pack::enable_incoming_utp, true);
    pack.set_bool(lt::settings_pack::enable_outgoing_tcp, false);
    pack.set_bool(lt::settings_pack::enable_incoming_tcp, true);
    pack.set_int(lt::settings_pack::utp_num_resends, 3);
    pack.set_int(lt::settings_pack::utp_connect_timeout, 4000);
    // udp/utp socket pinned to the physical nic — the tunnel's relay
    // drops udp to peer ports, while direct en0 udp reaches peers fine.
    // (tracker announces don't use this socket — boostPeers() runs its
    // own announces on unbound sockets through the tunnel.)
    pack.set_str(lt::settings_pack::listen_interfaces,
        getenv("KS_IFACE")
            ? std::string(getenv("KS_IFACE")) + ":6881"
            : "en0:6881");
    auto alertMask = lt::alert_category::error
        | lt::alert_category::status
        | lt::alert_category::piece_progress
        | lt::alert_category::connect
        | lt::alert_category::dht
        | lt::alert_category::performance_warning;
    pack.set_int(lt::settings_pack::alert_mask,
        static_cast<int>(static_cast<unsigned int>(alertMask)));
    return pack;
}

Engine::Engine() : ses_(makeSettings()) {
    const char* home = getenv("HOME");
    cacheDir_ = std::string(home ? home : "/tmp") + "/Library/Caches/kinostream";
    ::mkdir(cacheDir_.c_str(), 0755);
    ::mkdir((cacheDir_ + "/resume").c_str(), 0755);
    verbose_ = getenv("KS_VERBOSE") != nullptr;
    alertThread_ = std::thread([this] { alertLoop(); });
    mirrorThread_ = std::thread([this] { mirrorLoop(); });
}

// Direct-first policy: peers and trackers go direct (fastest, most peers).
// If a session can't pull metadata within ~8s the watchdog calls this once —
// it lazily spawns xray and flips trackers+peers onto the socks proxy.
void Engine::enableProxy() {
    bool expected = false;
    if (!proxyOn_.compare_exchange_strong(expected, true)) return;
    if (spawnProxy_) spawnProxy_(); // bring xray up if needed (blocks ~1s)
    lt::settings_pack p;
    p.set_int(lt::settings_pack::proxy_type, lt::settings_pack::socks5);
    p.set_str(lt::settings_pack::proxy_hostname, "127.0.0.1");
    p.set_int(lt::settings_pack::proxy_port, 12080);
    p.set_bool(lt::settings_pack::proxy_peer_connections, true);
    p.set_bool(lt::settings_pack::proxy_tracker_connections, true);
    p.set_bool(lt::settings_pack::proxy_hostnames, true);
    ses_.apply_settings(std::move(p));
    fprintf(stderr, "ksengine: torrent proxy on (socks5://127.0.0.1:12080)\n");
    std::lock_guard<std::mutex> lk(mtx_);
    for (auto& [id, s] : sessions_)
        if (s->handle.is_valid()) s->handle.force_reannounce();
}

Engine::~Engine() {
    running_ = false;
    mirrorCv_.notify_all();
    if (mirrorThread_.joinable()) mirrorThread_.join();
    ses_.abort();
    if (alertThread_.joinable()) alertThread_.join();
    for (auto& [id, s] : sessions_) {
        if (s->diskFd >= 0) ::close(s->diskFd);
    }
}

static int matchFile(const lt::file_storage& fs, int requested,
                     const std::string& query, bool fallback);

std::shared_ptr<StreamSession> Engine::addTorrent(
    const std::string& infoHash, const std::vector<std::string>& trackers,
    const std::string& title, int fileIdx, bool isDownload,
    const std::string& fileQuery, bool warmOnly)
{
    auto s = std::make_shared<StreamSession>();
    s->id = infoHash;
    s->infoHash = infoHash;
    s->title = title;
    s->isDownload = isDownload;
    s->warmOnly = warmOnly;
    s->requestedFileIdx = fileIdx;
    s->fileQuery = fileQuery;
    s->lastDataAt = nowUs();
    s->addedAtUs = nowUs();

    std::string magnet = "magnet:?xt=urn:btih:" + infoHash;
    static const char* defaults[] = {
        // http(s) trackers work through the socks proxy; udp ones need direct net
        "http://tracker.gbitt.info:80/announce",
        "https://tracker.lilithraws.org:443/announce",
        "http://open.acgnxtracker.com:80/announce",
        "http://tracker.bt4g.com:2095/announce",
        "https://tracker.tamersunion.org:443/announce",
        "http://tracker810.xyz:11451/announce",
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://explodie.org:6969/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "udp://open.demonii.ch:1337/announce",
        "udp://tracker.denis.stalker.uw1234.com:5737/announce",
        "udp://tracker.moeking.me:6969/announce",
        "udp://opentracker.i2p.rocks:6969/announce",
        "udp://tracker.1er.cc:2710/announce",
        "http://tracker.openbittorrent.com:80/announce",
    };
    for (auto* t : defaults) magnet += "&tr=" + std::string(t);
    for (auto& t : trackers) {
        // percent-encode tracker URL for magnet
        std::string enc;
        for (char c : t) {
            if (isalnum((unsigned char)c) || strchr("-_.~:/?&=", c)) enc.push_back(c);
            else { char b[4]; snprintf(b, 4, "%%%02X", (unsigned char)c); enc += b; }
        }
        magnet += "&tr=" + enc;
    }
    if (!title.empty()) {
        magnet += "&dn=";
        for (char c : title) {
            if (isalnum((unsigned char)c) || strchr("-_.~ ", c)) magnet.push_back(c == ' ' ? '+' : c);
        }
    }

    lt::add_torrent_params atp;
    try {
        atp = lt::parse_magnet_uri(magnet);
    } catch (...) {
        s->error = "bad magnet";
        s->dead = true;
        return s;
    }

    // fast path: resume data from a previous run carries the torrent_info —
    // metadata is instant and already-downloaded pieces are verified
    {
        std::ifstream rf(resumePath(infoHash), std::ios::binary);
        if (rf) {
            std::vector<char> buf((std::istreambuf_iterator<char>(rf)),
                                  std::istreambuf_iterator<char>());
            try {
                auto ratp = lt::read_resume_data(buf);
                if (ratp.ti && ratp.ti->is_valid()) {
                    ratp.trackers.insert(ratp.trackers.end(),
                        atp.trackers.begin(), atp.trackers.end());
                    ratp.tracker_tiers.insert(ratp.tracker_tiers.end(),
                        atp.tracker_tiers.begin(), atp.tracker_tiers.end());
                    atp = std::move(ratp);
                }
            } catch (...) {}
        }
    }

    atp.save_path = cacheDir_;
    atp.flags &= ~lt::torrent_flags::paused;
    atp.flags |= lt::torrent_flags::auto_managed;
    const bool needsMetadata = !atp.ti || !atp.ti->is_valid();
    const bool privTorrent = atp.ti && atp.ti->priv();

    {
        std::lock_guard<std::mutex> lk(mtx_);
        if (!isDownload && !warmOnly) {
            // one hot play session; downloads + a same-hash session survive —
            // downloads must never kill what's currently playing, and a
            // same-hash play session is retargeted below (instant episode
            // switch inside season packs)
            for (auto it = sessions_.begin(); it != sessions_.end();) {
                auto& old = it->second;
                if (old->isDownload || old->infoHash == infoHash) { ++it; continue; }
                if (old->catalogued && old->infoHash != infoHash && !old->isDownload) {
                    old->isDownload = true;
                    old->warmOnly = false;
                    if (old->handle.is_valid()) {
                        old->handle.set_flags(lt::torrent_flags::sequential_download);
                        applyFilePriorities(old);
                    }
                    ++it; continue;
                }
                fprintf(stderr, "ksengine: dropping session %s for %s\n",
                        old->id.c_str(), s->id.c_str());
                if (old->handle.is_valid()) {
                    requestResumeSave(old);
                    ses_.remove_torrent(old->handle);
                }
                old->dead = true;
                old->cv.notify_all();
                if (old->diskFd >= 0) { ::close(old->diskFd); old->diskFd = -1; }
                it = sessions_.erase(it);
            }
            for (auto it = transmuxers_.begin(); it != transmuxers_.end();) {
                if (it->first == infoHash) { ++it; continue; }
                it->second->cancel();
                it = transmuxers_.erase(it);
            }
        } else if (warmOnly) {
            for (auto it = sessions_.begin(); it != sessions_.end();) {
                auto& old = it->second;
                if (old->warmOnly && old->infoHash != infoHash) {
                    if (old->handle.is_valid()) {
                        requestResumeSave(old);
                        ses_.remove_torrent(old->handle);
                    }
                    old->dead = true;
                    old->cv.notify_all();
                    it = sessions_.erase(it);
                    continue;
                }
                ++it;
            }
        }
        // same torrent already known? don't add a duplicate handle —
        // promote a download to a play session, or retarget the file/episode
        for (auto& [id, old] : sessions_) {
            if (old->infoHash == infoHash) {
                s = old;
                s->title = title.empty() ? s->title : title;
                bool sameTarget = s->requestedFileIdx == fileIdx && s->fileQuery == fileQuery;
                if (isDownload && s->warmOnly) { s->warmOnly = false; s->isDownload = true; }
                if (!sameTarget && warmOnly) {
                    // playing one file, asked to download another inside the
                    // SAME torrent (next episode in a season pack) — keep the
                    // play session and pull that file alongside
                    s->prefetchFileIdx = fileIdx;
                    s->prefetchFileQuery = fileQuery;
                    if (s->metadataReady) {
                        applyFilePriorities(s);
                        scheduleWindow(s, s->playhead);
                    }
                    return s;
                }
                if (isDownload && s->catalogued) return s;
                if (isDownload && !s->isDownload) return s;
                if (warmOnly) return s;
                if (!isDownload && !sameTarget && s->metadataReady &&
                    !fileQuery.empty() && s->prefetchFileQuery == fileQuery) {
                    auto ti = s->handle.torrent_file();
                    if (ti && matchFile(ti->layout(), fileIdx, fileQuery, false) < 0)
                        return {};
                }
                s->isDownload = s->isDownload && isDownload; // play is sticky
                if (!isDownload) s->warmOnly = false;
                s->requestedFileIdx = fileIdx;
                s->fileQuery = fileQuery;
                s->prefetchFileIdx = -1;
                s->prefetchFileQuery.clear();
                if (s->metadataReady && !sameTarget) {
                    // repoint at the new file (e.g. next episode in a pack):
                    // kill the stale demuxer + fd, re-pick, restart the window
                    auto txIt = transmuxers_.find(s->id);
                    if (txIt != transmuxers_.end()) { txIt->second->cancel(); transmuxers_.erase(txIt); }
                    if (s->diskFd >= 0) { ::close(s->diskFd); s->diskFd = -1; }
                    if (chooseFile(s)) { s->playhead = 0; scheduleWindow(s, 0); }
                } else if (s->metadataReady && !isDownload) {
                    s->handle.unset_flags(lt::torrent_flags::sequential_download);
                    applyFilePriorities(s);
                    scheduleWindow(s, s->playhead);
                }
                return s;
            }
        }

        s->handle = ses_.add_torrent(std::move(atp));
        s->handle.resume();
        sessions_[s->id] = s;
        byHash_[infoHashHex(s->handle.info_hashes())] = s;
    }

    if (needsMetadata && s->handle.is_valid()) {
        std::lock_guard<std::mutex> lk(mirrorMtx_);
        if (mirrorJobs_.size() < 16) {
            mirrorJobs_.push_back(s);
            mirrorCv_.notify_one();
        }
    }

    if (!privTorrent) {
        std::vector<std::string> boostList(trackers);
        for (auto* t : defaults) boostList.emplace_back(t);
        std::thread(&Engine::boostPeers, this, s, std::move(boostList)).detach();
    }
    return s;
}

// trackers don't work over the bound en0 sockets (udp dropped by isp,
// some names dns-poisoned) — so announces run here on unbound sockets,
// which ride the relayed tunnel path, and discovered peers are injected
// straight into the session; payload then flows over uTP
void Engine::boostPeers(std::shared_ptr<StreamSession> s,
                        std::vector<std::string> trackers) {
    auto infoHash = hexToBytes(s->infoHash);
    std::vector<uint8_t> peerId(20);
    const char* pid = "-KS0001-";
    memcpy(peerId.data(), pid, 8);
    for (int i = 8; i < 20; ++i) peerId[i] = (uint8_t)arc4random();

    std::unordered_set<std::string> seen;
    std::atomic<int> injected{0};
    // bring the udp relay up — international peers only reach us through the
    // vless tunnel, domestic peers still get direct connects. xray is spawned
    // lazily on first use; the associate is retried every pass so a proxy
    // that comes up late (or dies and respawns) is picked up mid-session.
    auto ensureRelay = [&]() -> std::shared_ptr<PeerRelay> {
        {
            std::lock_guard<std::mutex> lk(relayMtx_);
            if (relay_ && relay_->active()) return relay_;
        }
        static std::once_flag xrayOnce;
        std::call_once(xrayOnce, [&] { if (spawnProxy_) spawnProxy_(); });
        auto r = std::make_shared<PeerRelay>();
        if (!r->start(12080)) return nullptr;
        fprintf(stderr, "ksengine: peer relay up via xray udp associate\n");
        std::lock_guard<std::mutex> lk(relayMtx_);
        relay_ = r;
        return r;
    };
    // outbound uTP is dpi-blocked on the isp edge — inbound connects are the
    // working path, and they only find us while trackers keep our public
    // endpoint fresh: re-announce the whole pass every 45s until saturated
    // announce to every tracker in PARALLEL — a dead tracker must not
    // serialize the whole pass behind its timeout
    std::mutex seenMtx;
    auto inject = [&](const std::vector<Peer>& peers) {
        std::shared_ptr<PeerRelay> rl;
        {
            std::lock_guard<std::mutex> lk(relayMtx_);
            rl = relay_;
        }
        for (auto& [ip, port] : peers) {
            if (port <= 1) continue;
            {
                std::lock_guard<std::mutex> lk(seenMtx);
                if (!seen.insert(ip + ":" + std::to_string(port)).second) continue;
            }
            try {
                lt::error_code ec;
                auto addr = lt::make_address(ip.c_str(), ec);
                if (ec || addr.is_unspecified()) continue;
                // direct first — works for domestic peers and punches a
                // nat hole; plus a relayed path for everyone else
                s->handle.connect_peer(lt::tcp::endpoint(addr, port));
                if (rl && rl->active()) {
                    in_addr ia{};
                    if (::inet_pton(AF_INET, ip.c_str(), &ia) == 1) {
                        uint16_t lp = rl->wrap(ia.s_addr, port);
                        if (lp) s->handle.connect_peer(lt::tcp::endpoint(
                            lt::make_address("127.0.0.1"), lp));
                    }
                }
                ++injected;
            } catch (const lt::system_error&) { break; }
              catch (...) {}
        }
    };

    // ~30min of passes: the tunnel flaps, so a pass that yields nothing now
    // may harvest a full swarm a minute later
    bool relayWarned = false;
    for (int pass = 0; pass < 40 && !s->dead.load(); ++pass) {
        if (!ensureRelay() && !relayWarned) {
            relayWarned = true;
            fprintf(stderr, "ksengine: no xray socks — relay off\n");
        }
        std::vector<std::thread> workers;
        workers.reserve(trackers.size());
        for (const std::string& url : trackers) {
            if (s->dead.load()) break;
            workers.emplace_back([&, url] {
                std::vector<Peer> peers;
                try {
                    if (url.rfind("udp://", 0) == 0) {
                        auto rest = url.substr(6);
                        auto colon = rest.rfind(':');
                        if (colon == std::string::npos) return;
                        auto slash = rest.find('/');
                        std::string host = rest.substr(0, colon);
                        uint16_t port = (uint16_t)strtoul(
                            rest.substr(colon + 1, slash - colon - 1).c_str(), nullptr, 10);
                        peers = udpAnnounce(host, port, infoHash, peerId);
                    } else if (url.rfind("http://", 0) == 0 || url.rfind("https://", 0) == 0) {
                        peers = httpAnnounce(url, infoHash, peerId);
                    }
                } catch (...) {}
                if (!peers.empty() && verbose_)
                    fprintf(stderr, "ksengine: %s -> %zu peers\n", url.c_str(), peers.size());
                inject(peers);
            });
        }
        for (auto& w : workers) if (w.joinable()) w.join();
        if (verbose_)
            fprintf(stderr, "ksengine: boost pass %d — %d peers injected\n",
                    pass, injected.load());
        int np = 0;
        try { np = s->handle.status().num_peers; } catch (...) {}
        if (np >= 30) break;
        for (int i = 0; i < 450 && !s->dead.load(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
    }
}

void Engine::mirrorLoop() {
    for (;;) {
        std::shared_ptr<StreamSession> s;
        {
            std::unique_lock<std::mutex> lk(mirrorMtx_);
            mirrorCv_.wait(lk, [&] {
                return !running_.load() || !mirrorJobs_.empty();
            });
            while (!mirrorJobs_.empty()) {
                s = mirrorJobs_.front().lock();
                mirrorJobs_.pop_front();
                if (s) break;
            }
            if (!s) {
                if (!running_) return;
                continue;
            }
        }
        if (!running_) return;
        if (s->dead || s->metadataReady) continue;
        std::vector<std::thread> workers;
        workers.reserve(sizeof(kMirrors) / sizeof(kMirrors[0]));
        for (const char* fmt : kMirrors) {
            workers.emplace_back([this, s, fmt] {
                auto buf = fetchTorrentFile(s->infoHash, fmt);
                if (buf.empty() || s->dead || s->metadataReady || !running_) return;
                try {
                    lt::bdecode_node node = lt::bdecode(
                        lt::span<const char>(buf.data(), buf.size()));
                    auto ti = std::make_shared<lt::torrent_info>(std::move(node));
                    if (ti->is_valid() && infoHashHex(ti->info_hashes()) == s->infoHash)
                        s->handle.set_metadata(ti->info_section());
                } catch (...) {}
            });
        }
        for (auto& w : workers) if (w.joinable()) w.join();
    }
}

std::shared_ptr<StreamSession> Engine::get(const std::string& id) {
    std::lock_guard<std::mutex> lk(mtx_);
    auto it = sessions_.find(id);
    return it == sessions_.end() ? nullptr : it->second;
}

bool Engine::waitMetadata(const std::shared_ptr<StreamSession>& s, int timeoutSec) {
    std::unique_lock<std::mutex> lk(s->mtx);
    return s->cv.wait_for(lk, std::chrono::seconds(timeoutSec),
        [&] { return s->metadataReady.load() || s->dead.load(); }) && s->metadataReady;
}

void Engine::alertLoop() {
    while (running_) {
        if (!ses_.wait_for_alert(lt::milliseconds(500))) {
            // tick: metadata may arrive via resume data / torrent_info
            // without a metadata_received alert — catch that here
            {
                std::lock_guard<std::mutex> lk(mtx_);
                for (auto& [id, s] : sessions_) {
                    if (s->metadataReady || !s->handle.is_valid()) continue;
                    try {
                        if (s->handle.status().has_metadata) onMetadata(s);
                    } catch (const lt::system_error&) {}
                }
            }
            // watchdog tick: a session still waiting on metadata after 8s
            // trips the socks-proxy fallback for the whole engine
            if (!proxyOn_.load() && getenv("KS_PROXY")) {
                bool trip = false;
                {
                    std::lock_guard<std::mutex> lk(mtx_);
                    for (auto& [id, s] : sessions_)
                        if (!s->metadataReady && !s->dead &&
                            nowUs() - s->addedAtUs > 8000000LL) { trip = true; break; }
                }
                if (trip) enableProxy();
            }
            continue;
        }
        std::vector<lt::alert*> alerts;
        ses_.pop_alerts(&alerts);
        for (lt::alert* a : alerts) {
            if (verbose_) fprintf(stderr, "ALERT %s\n", a->message().c_str());
            auto* ta = dynamic_cast<lt::torrent_alert*>(a);
            std::shared_ptr<StreamSession> s;
            if (ta) {
                std::lock_guard<std::mutex> lk(mtx_);
                try {
                    auto it = byHash_.find(infoHashHex(ta->handle.info_hashes()));
                    if (it != byHash_.end()) s = it->second.lock();
                } catch (const lt::system_error&) {}
            }
            if (s && !s->metadataReady && s->handle.is_valid()) {
                try {
                    if (s->handle.status().has_metadata) onMetadata(s);
                } catch (const lt::system_error&) {}
            }
            if (lt::alert_cast<lt::file_prio_alert>(a)) {
                if (s && s->metadataReady && s->handle.is_valid())
                    reapplyPieceOverrides(s);
            }
            if (lt::alert_cast<lt::metadata_received_alert>(a)) {
                if (s && !s->metadataReady) onMetadata(s);
            } else if (lt::alert_cast<lt::piece_finished_alert>(a)) {
                if (s) { std::lock_guard<std::mutex> lk(s->mtx); s->cv.notify_all(); }
            } else if (auto* tea = lt::alert_cast<lt::torrent_error_alert>(a)) {
                if (s) {
                    std::lock_guard<std::mutex> lk(s->mtx);
                    s->error = tea->error.message();
                }
            } else if (auto* taa = lt::alert_cast<lt::tracker_error_alert>(a)) {
                // keep last tracker error for status, not fatal
                if (s) {
                    std::lock_guard<std::mutex> lk(s->mtx);
                    if (s->error.empty()) s->error = taa->error.message();
                }
            } else if (auto* srd = lt::alert_cast<lt::save_resume_data_alert>(a)) {
                // persist for instant metadata next time
                try {
                    std::string hash = s ? s->infoHash : infoHashHex(srd->handle.info_hashes());
                    auto buf = lt::write_resume_data_buf(srd->params);
                    std::ofstream of(resumePath(hash), std::ios::binary | std::ios::trunc);
                    of.write(buf.data(), buf.size());
                } catch (...) {}
            } else if (lt::alert_cast<lt::torrent_finished_alert>(a)) {
                if (s) requestResumeSave(s);
            }
            if (auto* dg = lt::alert_cast<lt::dht_get_peers_reply_alert>(a)) {
                // dht peers get dialed directly by libtorrent — dead end for
                // international ones; mirror them onto the relay instead
                if (relay_ && relay_->active()) {
                    std::shared_ptr<StreamSession> ds;
                    {
                        std::lock_guard<std::mutex> lk(mtx_);
                        auto it = byHash_.find(hexEncode(
                            reinterpret_cast<const uint8_t*>(dg->info_hash.data()), 20));
                        if (it != byHash_.end()) ds = it->second.lock();
                    }
                    if (ds) {
                        for (auto& ep : dg->peers()) {
                            if (!ep.address().is_v4()) continue;
                            auto v4 = ep.address().to_v4().to_bytes();
                            in_addr ia{}; memcpy(&ia.s_addr, v4.data(), 4);
                            uint16_t lp = relay_->wrap(ia.s_addr, ep.port());
                            if (lp) {
                                try {
                                    ds->handle.connect_peer(lt::tcp::endpoint(
                                        lt::make_address("127.0.0.1"), lp));
                                } catch (...) {}
                            }
                        }
                    }
                }
            }
        }
    }
}

// file match: requested index → regex on video paths (episode in pack) →
// largest video → largest file. `fallback` off for prefetch targets — a
// non-matching query must not grab an arbitrary file.
static int matchFile(const lt::file_storage& fs, int requested,
                     const std::string& query, bool fallback) {
    int pick = requested;
    if (pick < 0 && !query.empty()) {
        try {
            std::regex re(query, std::regex::icase);
            for (int i = 0; i < fs.num_files(); ++i) {
                std::string p = fs.file_path(lt::file_index_t{i});
                if (isVideoPath(p) && std::regex_search(p, re)) { pick = i; break; }
            }
        } catch (...) {}
    }
    if (pick >= 0 && pick < fs.num_files() &&
        isVideoPath(std::string(fs.file_path(lt::file_index_t{pick}))))
        return pick;
    if (!fallback) return -1;
    int64_t bestSize = -1; int best = -1;
    for (int i = 0; i < fs.num_files(); ++i) {
        std::string p = fs.file_path(lt::file_index_t{i});
        int64_t sz = fs.file_size(lt::file_index_t{i});
        if (isVideoPath(p) && sz > bestSize) { bestSize = sz; best = i; }
    }
    if (best < 0) {
        for (int i = 0; i < fs.num_files(); ++i) {
            int64_t sz = fs.file_size(lt::file_index_t{i});
            if (sz > bestSize) { bestSize = sz; best = i; }
        }
    }
    return best;
}

void Engine::applyFilePriorities(const std::shared_ptr<StreamSession>& s) {
    auto ti = s->handle.torrent_file();
    if (!ti) return;
    const lt::file_storage& fs = ti->layout();
    std::vector<lt::download_priority_t> fp(fs.num_files(), lt::dont_download);
    std::vector<std::pair<int, std::string>> dts;
    {
        std::lock_guard<std::mutex> lk(s->targetsMtx);
        dts = s->downloadTargets;
    }
    int dlFile = -1;
    for (auto& [idx, q] : dts) {
        int pick = matchFile(fs, idx, q, idx < 0 && q.empty());
        if (pick >= 0 && pick < fs.num_files()) {
            fp[pick] = lt::default_priority;
            if (pick == s->fileIndex) dlFile = pick;
        }
    }
    s->scheduledDownloadFile = dlFile;
    if (!s->isDownload && !s->warmOnly &&
        s->fileIndex >= 0 && s->fileIndex < fs.num_files()) {
        fp[s->fileIndex] = lt::top_priority;
    } else if (s->isDownload && dts.empty() &&
               s->fileIndex >= 0 && s->fileIndex < fs.num_files()) {
        fp[s->fileIndex] = lt::default_priority;
    }
    if (s->warmOnly && s->fileIndex >= 0 && s->fileIndex < fs.num_files() &&
        fp[s->fileIndex] == lt::dont_download)
        fp[s->fileIndex] = lt::low_priority;
    int pf = matchFile(fs, s->prefetchFileIdx, s->prefetchFileQuery, false);
    if (pf >= 0 && pf != s->fileIndex && fp[pf] == lt::dont_download)
        fp[pf] = lt::low_priority;
    s->handle.prioritize_files(fp);
    reapplyPieceOverrides(s);
}

void Engine::applyHeadTail(const std::shared_ptr<StreamSession>& s, int pick,
                           const lt::file_storage& fs) {
    int64_t fOff = fs.file_offset(lt::file_index_t{pick});
    int64_t fSize = fs.file_size(lt::file_index_t{pick});
    int pieceLen = fs.piece_length();
    int firstP = int(fOff / pieceLen);
    int lastP = int((fOff + fSize - 1) / pieceLen);
    int headEnd = int((fOff + std::min(kHeadBytes, fSize)) / pieceLen);
    int tailStart = int((fOff + std::max<int64_t>(0, fSize - kTailBytes)) / pieceLen);
    try {
        for (int p = firstP; p <= std::min(headEnd, lastP); ++p) {
            if (s->handle.have_piece(lt::piece_index_t{p})) continue;
            s->handle.piece_priority(lt::piece_index_t{p}, lt::top_priority);
            s->handle.set_piece_deadline(lt::piece_index_t{p}, 1000 + (p - firstP) * 60,
                lt::torrent_handle::alert_when_available);
        }
        for (int p = std::max(tailStart, headEnd + 1); p <= lastP; ++p) {
            if (s->handle.have_piece(lt::piece_index_t{p})) continue;
            s->handle.piece_priority(lt::piece_index_t{p}, lt::top_priority);
            s->handle.set_piece_deadline(lt::piece_index_t{p}, 2000,
                lt::torrent_handle::alert_when_available);
        }
    } catch (const lt::system_error&) {}
}

void Engine::reapplyPieceOverrides(const std::shared_ptr<StreamSession>& s) {
    auto ti = s->handle.torrent_file();
    if (!ti) return;
    const lt::file_storage& fs = ti->layout();
    std::vector<lt::download_priority_t> priorities;
    try { priorities = s->handle.get_file_priorities(); } catch (...) {}
    auto applyPreview = [&](int idx) {
        if (idx < 0 || idx >= fs.num_files()) return;
        if (idx < (int)priorities.size() &&
            priorities[static_cast<size_t>(idx)] == lt::low_priority) {
            const auto off = fs.file_offset(lt::file_index_t{idx});
            const auto size = fs.file_size(lt::file_index_t{idx});
            if (size <= 0) return;
            const auto len = fs.piece_length();
            const int firstMiddle = int((off + std::min(size, kHeadBytes) - 1) / len) + 1;
            const int tail = int((off + std::max<int64_t>(0, size - kTailBytes)) / len);
            std::vector<std::pair<lt::piece_index_t, lt::download_priority_t>> middle;
            for (int p = firstMiddle; p < tail; ++p)
                middle.emplace_back(lt::piece_index_t{p}, lt::dont_download);
            if (!middle.empty()) s->handle.prioritize_pieces(middle);
        }
        applyHeadTail(s, idx, fs);
    };
    if (s->warmOnly) applyPreview(s->fileIndex);
    int pf = matchFile(fs, s->prefetchFileIdx, s->prefetchFileQuery, false);
    if (pf >= 0 && pf != s->fileIndex) applyPreview(pf);
    scheduleWindow(s, s->playhead);
}

void Engine::setDownloadTargets(const std::shared_ptr<StreamSession>& s,
                                std::vector<std::pair<int, std::string>> targets) {
    {
        std::lock_guard<std::mutex> lk(s->targetsMtx);
        s->downloadTargets = std::move(targets);
        s->catalogued = !s->downloadTargets.empty();
    }
    if (s->catalogued) s->warmOnly = false;
    if (s->metadataReady) {
        applyFilePriorities(s);
        scheduleWindow(s, s->playhead);
    }
}

// pick file: requested index → regex match (episode in pack) → largest video
// → largest file. Also (re)targets the session: file fields, per-file
// priorities, head/tail deadlines. Safe to call again when the session is
// re-pointed at a different file inside the same torrent.
bool Engine::chooseFile(const std::shared_ptr<StreamSession>& s) {
    auto ti = s->handle.torrent_file();
    if (!ti) return false;
    const lt::file_storage& fs = ti->layout();

    int pick = matchFile(fs, s->requestedFileIdx, s->fileQuery,
        !(s->warmOnly && (s->requestedFileIdx >= 0 || !s->fileQuery.empty())));
    if (pick < 0) return false;

    {
        std::lock_guard<std::mutex> lk(s->mtx);
        s->fileIndex = pick;
        s->fileOffset = fs.file_offset(lt::file_index_t{pick});
        s->fileSize = fs.file_size(lt::file_index_t{pick});
        s->fileName = fs.file_name(lt::file_index_t{pick});
        s->mime = mimeFor(s->fileName);
        s->pieceLength = fs.piece_length();
        s->firstPiece = int(s->fileOffset / s->pieceLength);
        s->lastPiece = int((s->fileOffset + s->fileSize - 1) / s->pieceLength);
        s->filePathOnDisk = cacheDir_ + "/" + fs.file_path(lt::file_index_t{pick});
    }

    applyFilePriorities(s);
    // background downloads go strictly in order — the head (moov, first
    // keyframes) lands early so a preload can be promoted to playback
    // instantly; play sessions use the sliding window instead
    if (s->isDownload)
        s->handle.set_flags(lt::torrent_flags::sequential_download);
    else
        s->handle.unset_flags(lt::torrent_flags::sequential_download);

    // head + tail priority so the transmuxer can probe container & cues immediately
    if (!s->warmOnly) applyHeadTail(s, pick, fs);
    return true;
}

void Engine::onMetadata(const std::shared_ptr<StreamSession>& s) {
    if (!chooseFile(s)) {
        std::lock_guard<std::mutex> lk(s->mtx);
        s->error = "no files in torrent"; s->dead = true; s->cv.notify_all();
        return;
    }
    {
        std::lock_guard<std::mutex> lk(s->mtx);
        s->metadataReady = true;
    }
    s->cv.notify_all();
    scheduleWindow(s, 0);
    requestResumeSave(s);
}

void Engine::noteSeek(const std::shared_ptr<StreamSession>& s, int64_t fileOff) {
    s->playhead = fileOff;
    s->lastSchedUs = 0;
    // drop stale deadlines from the old window, then reprioritize — pieces
    // outside the new window get dont_download, which cancels their in-flight
    // block requests so peer queues and bandwidth go to the seek target
    try { s->handle.clear_piece_deadlines(); } catch (...) {}
    scheduleWindow(s, fileOff);
}

void Engine::scheduleWindow(const std::shared_ptr<StreamSession>& s, int64_t fileOff) {
    if (!s->metadataReady || s->dead || s->isDownload || s->warmOnly) return;
    int64_t winLo = std::max<int64_t>(0, fileOff - kBehindBytes);
    int64_t winHi = std::min(s->fileSize, fileOff + kAheadBytes);
    int pLo = int((s->fileOffset + winLo) / s->pieceLength);
    int pHi = int((s->fileOffset + winHi - 1) / s->pieceLength);
    int64_t marLo = std::max<int64_t>(0, winLo - kMarginBytes);
    int64_t marHi = std::min(s->fileSize, winHi + kMarginBytes);
    int mLo = int((s->fileOffset + marLo) / s->pieceLength);
    int mHi = int((s->fileOffset + marHi - 1) / s->pieceLength);

    try {
        for (int p = s->firstPiece; p <= s->lastPiece; ++p) {
            if (p >= pLo && p <= pHi) {
                if (!s->handle.have_piece(lt::piece_index_t{p})) {
                    s->handle.piece_priority(lt::piece_index_t{p}, lt::top_priority);
                    // deadline scales with distance ahead of playhead —
                    // keep above ensurePieces' critical deadlines (<=1.5s)
                    int64_t bytesAhead = std::max<int64_t>(0, (int64_t)p * s->pieceLength - s->fileOffset - fileOff);
                    int deadline = 3000 + int(bytesAhead / (2 * 1024 * 1024)) * 400;
                    s->handle.set_piece_deadline(lt::piece_index_t{p}, std::min(deadline, 30000),
                        lt::torrent_handle::alert_when_available);
                }
            } else if (p >= mLo && p <= mHi) {
                s->handle.piece_priority(lt::piece_index_t{p}, lt::low_priority);
            } else {
                s->handle.piece_priority(lt::piece_index_t{p},
                    s->scheduledDownloadFile == s->fileIndex
                        ? lt::default_priority : lt::dont_download);
            }
        }
    } catch (const lt::system_error&) {}
}

bool Engine::ensurePieces(const std::shared_ptr<StreamSession>& s, int first, int last) {
    int64_t stallStart = nowUs();
    int lastDone = -1;
    for (;;) {
        bool all = true;
        try {
            for (int p = first; p <= last; ++p) {
                if (!s->handle.have_piece(lt::piece_index_t{p})) {
                    all = false;
                    s->handle.piece_priority(lt::piece_index_t{p}, lt::top_priority);
                    // urgent — below every window deadline so the read
                    // unblocks before background prefetch gets bandwidth
                    s->handle.set_piece_deadline(lt::piece_index_t{p},
                        200 + (p - first) * 60, lt::torrent_handle::alert_when_available);
                }
            }
        } catch (const lt::system_error&) { return false; } // handle removed mid-read
        if (all) return true;
        if (s->dead) return false;

        // find lowest missing piece as progress marker
        int lowest = last;
        try {
            for (int p = first; p <= last; ++p)
                if (!s->handle.have_piece(lt::piece_index_t{p})) { lowest = p; break; }
        } catch (const lt::system_error&) { return false; }
        if (lowest != lastDone) { lastDone = lowest; stallStart = nowUs(); }
        if (nowUs() - stallStart > kStallTimeoutSec * 1000000LL) return false;

        std::unique_lock<std::mutex> lk(s->mtx);
        s->cv.wait_for(lk, 120ms, [&]{ return s->dead.load(); });
    }
}

std::string Engine::resumePath(const std::string& infoHash) const {
    return cacheDir_ + "/resume/" + infoHash + ".resume";
}

void Engine::requestResumeSave(const std::shared_ptr<StreamSession>& s) {
    try {
        if (s->handle.is_valid())
            s->handle.save_resume_data(lt::torrent_handle::only_if_modified
                | lt::torrent_handle::save_info_dict);
    } catch (...) {}
}

int Engine::openFd(const std::shared_ptr<StreamSession>& s) {
    if (s->diskFd >= 0) return s->diskFd;
    int fd = ::open(s->filePathOnDisk.c_str(), O_RDONLY);
    if (fd >= 0) s->diskFd = fd;
    return fd;
}

bool Engine::readRange(const std::shared_ptr<StreamSession>& s, int64_t off, int64_t len,
                       const std::function<bool(const char*, size_t)>& sink) {
    if (!s->metadataReady || s->dead) return false;
    if (off < 0) off = 0;
    if (off >= s->fileSize || len <= 0) return true;
    len = std::min(len, s->fileSize - off);

    int fd = openFd(s);
    if (fd < 0) {
        // file may not be created yet — wait for first piece then retry
        if (!ensurePieces(s, s->firstPiece, s->firstPiece)) return false;
        fd = openFd(s);
        if (fd < 0) return false;
    }

    int64_t done = 0;
    std::vector<char> buf(1 << 20); // 1 MiB chunks
    while (done < len) {
        int64_t absOff = s->fileOffset + off + done;
        int64_t chunk = std::min<int64_t>((int64_t)buf.size(), len - done);
        int firstP = int(absOff / s->pieceLength);
        int lastP = int((absOff + chunk - 1) / s->pieceLength);

        if (!ensurePieces(s, firstP, lastP)) return false;

        ssize_t n = ::pread(fd, buf.data(), chunk, off + done);
        if (n <= 0) {
            ::close(fd); s->diskFd = -1;
            fd = openFd(s);
            if (fd < 0) return false;
            n = ::pread(fd, buf.data(), chunk, off + done);
            if (n <= 0) return false;
        }
        if (!sink(buf.data(), (size_t)n)) return false;
        done += n;

        // keep the download window just ahead of the playhead
        s->playhead = off + done;
        int64_t now = nowUs();
        if (now - s->lastSchedUs > 2000000) {
            s->lastSchedUs = now;
            scheduleWindow(s, s->playhead);
        }
    }
    return true;
}

int64_t Engine::readAt(const std::shared_ptr<StreamSession>& s, int64_t off, uint8_t* buf, int64_t n) {
    if (!s->metadataReady || s->dead || n <= 0) return 0;
    if (off < 0) off = 0;
    if (off >= s->fileSize) return 0;
    n = std::min(n, s->fileSize - off);

    int fd = openFd(s);
    if (fd < 0) {
        if (!ensurePieces(s, s->firstPiece, s->firstPiece)) return 0;
        fd = openFd(s);
        if (fd < 0) return 0;
    }

    int64_t absOff = s->fileOffset + off;
    int firstP = int(absOff / s->pieceLength);
    int lastP = int((absOff + n - 1) / s->pieceLength);
    if (!ensurePieces(s, firstP, lastP)) return 0;

    int64_t got = 0;
    while (got < n) {
        ssize_t r = ::pread(fd, buf + got, n - got, off + got);
        if (r <= 0) {
            ::close(fd); s->diskFd = -1;
            fd = openFd(s);
            if (fd < 0) break;
            r = ::pread(fd, buf + got, n - got, off + got);
            if (r <= 0) break;
        }
        got += r;
    }
    s->playhead = off + got;
    int64_t now = nowUs();
    if (now - s->lastSchedUs > 2000000) {
        s->lastSchedUs = now;
        scheduleWindow(s, s->playhead);
    }
    return got;
}

std::vector<FileEntry> Engine::files(const std::shared_ptr<StreamSession>& s) {
    std::vector<FileEntry> out;
    if (!s->metadataReady) return out;
    auto ti = s->handle.torrent_file();
    if (!ti) return out;
    const lt::file_storage& fs = ti->layout();
    for (int i = 0; i < fs.num_files(); ++i) {
        out.push_back({i, std::string(fs.file_path(lt::file_index_t{i})),
                       fs.file_size(lt::file_index_t{i}), i == s->fileIndex});
    }
    return out;
}

std::shared_ptr<Transmuxer> Engine::transmuxer(const std::shared_ptr<StreamSession>& s) {
    std::lock_guard<std::mutex> lk(mtx_);
    auto it = transmuxers_.find(s->id);
    if (it != transmuxers_.end()) return it->second;
    auto tx = std::make_shared<Transmuxer>(*this, s);
    transmuxers_[s->id] = tx;
    return tx;
}

void Engine::cancelTransmux(const std::string& id) {
    std::shared_ptr<Transmuxer> tx;
    {
        std::lock_guard<std::mutex> lk(mtx_);
        auto it = transmuxers_.find(id);
        if (it != transmuxers_.end()) tx = it->second;
    }
    if (tx) tx->cancel();
}

void Engine::stop(const std::string& id) {
    std::lock_guard<std::mutex> lk(mtx_);
    fprintf(stderr, "ksengine: stop(%s)\n", id.c_str());
    auto it = sessions_.find(id);
    {
        auto txIt = transmuxers_.find(id);
        if (txIt != transmuxers_.end()) { txIt->second->cancel(); transmuxers_.erase(txIt); }
    }
    if (it == sessions_.end()) return;
    auto& s = it->second;
    s->dead = true;
    s->cv.notify_all();
    if (s->handle.is_valid()) { requestResumeSave(s); ses_.remove_torrent(s->handle); }
    if (s->diskFd >= 0) { ::close(s->diskFd); s->diskFd = -1; }
    sessions_.erase(it);
}

void Engine::stopAll() {
    std::lock_guard<std::mutex> lk(mtx_);
    for (auto& [id, s] : sessions_) {
        s->dead = true;
        s->cv.notify_all();
        if (s->handle.is_valid()) { requestResumeSave(s); ses_.remove_torrent(s->handle); }
        if (s->diskFd >= 0) ::close(s->diskFd);
    }
    sessions_.clear();
}

std::string Engine::statusJson(const std::shared_ptr<StreamSession>& s) {
    json j;
    j["id"] = s->id;
    j["title"] = s->title;
    j["dead"] = s->dead.load();
    j["metadata"] = s->metadataReady.load();
    if (!s->handle.is_valid()) {
        if (!s->error.empty()) j["error"] = s->error;
        j["state"] = "removed"; return j.dump();
    }
    if (!s->metadataReady) {
        if (!s->error.empty()) j["error"] = s->error;
        j["state"] = "metadata"; return j.dump();
    }

    lt::torrent_status st;
    try { st = s->handle.status(); }
    catch (const lt::system_error&) { j["state"] = "removed"; return j.dump(); }
    // nonfatal errors (tracker unreachable etc.) only surface while the
    // swarm is actually stalled — a flowing download clears the picture
    if (!s->error.empty() && (s->dead || (st.download_rate == 0 && st.num_peers == 0)))
        j["error"] = s->error;
    j["state"] = [&]{
        switch (st.state) {
            case lt::torrent_status::downloading: return "downloading";
            case lt::torrent_status::finished: return "finished";
            case lt::torrent_status::seeding: return "seeding";
            case lt::torrent_status::downloading_metadata: return "metadata";
            case lt::torrent_status::checking_files: return "checking";
            case lt::torrent_status::checking_resume_data: return "checking";
            default: return "idle";
        }
    }();
    j["file"] = s->fileName;
    j["fileSize"] = s->fileSize;
    j["filePath"] = s->filePathOnDisk;
    j["isDownload"] = s->isDownload;
    j["progress"] = st.progress;
    j["downloadRate"] = st.download_rate;
    j["uploadRate"] = st.upload_rate;
    j["peers"] = st.num_peers;
    j["seeds"] = st.num_seeds;
    j["playhead"] = s->playhead.load();
    return j.dump();
}

std::string Engine::targetStatusJson(const std::shared_ptr<StreamSession>& s,
                                     int fileIdx, const std::string& fileQuery,
                                     bool strict) {
    json j;
    if (s && s->handle.is_valid()) {
        auto base = json::parse(statusJson(s), nullptr, false);
        if (base.is_object()) j = std::move(base);
    }
    j["metadata"] = s && s->metadataReady.load();
    j["ready"] = false;
    j["warm"] = false;
    if (!s || !s->metadataReady || !s->handle.is_valid()) return j.dump();
    auto ti = s->handle.torrent_file();
    if (!ti) return j.dump();
    const lt::file_storage& fs = ti->layout();
    int pick = matchFile(fs, fileIdx, fileQuery, !strict);
    if (pick < 0) {
        if (strict) {
            j.erase("file");
            j.erase("fileIdx");
            j.erase("fileSize");
            j.erase("filePath");
        }
        return j.dump();
    }

    int64_t fOff = fs.file_offset(lt::file_index_t{pick});
    int64_t fSize = fs.file_size(lt::file_index_t{pick});
    std::string fPath = cacheDir_ + "/" + std::string(fs.file_path(lt::file_index_t{pick}));
    if (fSize <= 0) {
        j["file"] = std::string(fs.file_name(lt::file_index_t{pick}));
        j["fileIdx"] = pick;
        j["fileSize"] = fSize;
        j["filePath"] = fPath;
        j["progress"] = 0.0;
        j["ready"] = false;
        j["warm"] = false;
        return j.dump();
    }
    int pieceLen = fs.piece_length();
    int firstP = int(fOff / pieceLen);
    int lastP = int((fOff + fSize - 1) / pieceLen);
    lt::torrent_status st;
    try { st = s->handle.status(lt::torrent_handle::query_pieces); }
    catch (const lt::system_error&) { return j.dump(); }
    const auto& pieces = st.pieces;
    auto has = [&](int p) {
        return p >= 0 && p < (int)pieces.size() &&
               pieces.get_bit(lt::piece_index_t{p});
    };
    int64_t have = 0;
    bool ready = true;
    for (int p = firstP; p <= lastP; ++p) {
        if (has(p)) {
            int64_t lo = std::max<int64_t>(fOff, (int64_t)p * pieceLen);
            int64_t hi = std::min<int64_t>(fOff + fSize, (int64_t)(p + 1) * pieceLen);
            have += std::max<int64_t>(0, hi - lo);
        } else ready = false;
    }
    int headEnd = int((fOff + std::min(fSize, kHeadBytes) - 1) / pieceLen);
    int tailStart = int((fOff + std::max<int64_t>(0, fSize - kTailBytes)) / pieceLen);
    bool warm = true;
    for (int p = firstP; p <= std::min(headEnd, lastP) && warm; ++p) warm = has(p);
    for (int p = std::max(tailStart, firstP); p <= lastP && warm; ++p) warm = has(p);
    struct stat fst{};
    const bool onDisk = ::stat(fPath.c_str(), &fst) == 0 && S_ISREG(fst.st_mode);
    if (!onDisk || fst.st_size < fSize) ready = false;
    if (!onDisk) warm = false;

    j["file"] = std::string(fs.file_name(lt::file_index_t{pick}));
    j["fileIdx"] = pick;
    j["fileSize"] = fSize;
    j["filePath"] = fPath;
    j["progress"] = (double)have / (double)fSize;
    j["ready"] = ready;
    j["warm"] = warm;
    return j.dump();
}

} // namespace ks
