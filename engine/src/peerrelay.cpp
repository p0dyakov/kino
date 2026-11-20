#include "peerrelay.hpp"

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

namespace ks {
namespace {

bool sendAll(int fd, const uint8_t* p, size_t n) {
    while (n > 0) {
        ssize_t w = ::send(fd, p, n, 0);
        if (w <= 0) return false;
        p += w; n -= (size_t)w;
    }
    return true;
}

} // namespace

bool PeerRelay::start(uint16_t socksPort) {
    if (running_.load()) return true;

    ctrl_ = ::socket(AF_INET, SOCK_STREAM, 0);
    if (ctrl_ < 0) return false;
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = htons(socksPort);
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::connect(ctrl_, (sockaddr*)&sa, sizeof(sa)) < 0) {
        ::close(ctrl_); ctrl_ = -1; return false;
    }
    // greeting: ver, 1 method, noauth
    if (!sendAll(ctrl_, (const uint8_t*)"\x05\x01\x00", 3)) goto fail;
    {
        uint8_t r[2];
        if (::recv(ctrl_, r, 2, MSG_WAITALL) != 2 || r[1] != 0) goto fail;
    }
    // UDP ASSOCIATE from 0.0.0.0:0
    if (!sendAll(ctrl_, (const uint8_t*)"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00", 10))
        goto fail;
    {
        uint8_t r[10];
        if (::recv(ctrl_, r, 10, MSG_WAITALL) != 10 || r[1] != 0 || r[3] != 1) goto fail;
        assoc_.sin_family = AF_INET;
        memcpy(&assoc_.sin_addr, r + 4, 4);
        memcpy(&assoc_.sin_port, r + 8, 2);
        // xray answers 0.0.0.0 — the udp socket really lives on loopback
        if (assoc_.sin_addr.s_addr == 0) assoc_.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    }
    data_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (data_ < 0) goto fail;

    running_ = true;
    thr_ = std::thread(&PeerRelay::loop, this);
    return true;
fail:
    ::close(ctrl_); ctrl_ = -1;
    if (data_ >= 0) { ::close(data_); data_ = -1; }
    return false;
}

void PeerRelay::stop() {
    running_ = false;
    if (thr_.joinable()) {
        // wake the poll — a zero-length datagram to ourselves is enough
        for (auto& [p, c] : chans_) { (void)p; ::close(c.fd); }
        chans_.clear();
        if (data_ >= 0) { ::close(data_); data_ = -1; }
        thr_.join();
    }
    if (ctrl_ >= 0) { ::close(ctrl_); ctrl_ = -1; }
}

uint16_t PeerRelay::wrap(uint32_t peerIpNetOrder, uint16_t peerPort) {
    if (!running_.load()) return 0;
    uint64_t key = (uint64_t)peerIpNetOrder << 16 | peerPort;
    std::lock_guard<std::mutex> lk(mtx_);
    auto it = byPeer_.find(key);
    if (it != byPeer_.end()) return it->second;
    if (chans_.size() >= 300) return 0;

    int fd = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return 0;
    sockaddr_in sa{};
    sa.sin_family = AF_INET;
    sa.sin_port = 0;
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::bind(fd, (sockaddr*)&sa, sizeof(sa)) < 0) { ::close(fd); return 0; }
    socklen_t sl = sizeof(sa);
    ::getsockname(fd, (sockaddr*)&sa, &sl);
    uint16_t port = ntohs(sa.sin_port);
    chans_[port] = Chan{fd, peerIpNetOrder, peerPort};
    byPeer_[key] = port;
    return port;
}

void PeerRelay::loop() {
    uint8_t buf[65536];
    while (running_.load()) {
        std::vector<pollfd> fds;
        {
            std::lock_guard<std::mutex> lk(mtx_);
            fds.reserve(chans_.size() + 1);
            if (data_ < 0) break;
            fds.push_back({data_, POLLIN, 0});
            for (auto& [p, c] : chans_) fds.push_back({c.fd, POLLIN, 0});
        }
        int n = ::poll(fds.data(), fds.size(), 250);
        if (n <= 0) continue;

        // replies coming back through the associate
        if (fds[0].revents & POLLIN) {
            sockaddr_in src{};
            socklen_t sl = sizeof(src);
            ssize_t r = ::recvfrom(data_, buf, sizeof(buf), 0, (sockaddr*)&src, &sl);
            if (r > 10 && buf[3] == 1) {           // atyp ipv4
                uint32_t peerIp; uint16_t peerPort;
                memcpy(&peerIp, buf + 4, 4);
                memcpy(&peerPort, buf + 8, 2);
                uint64_t key = (uint64_t)peerIp << 16 | ntohs(peerPort);
                std::lock_guard<std::mutex> lk(mtx_);
                auto it = byPeer_.find(key);
                if (getenv("KS_VERBOSE")) {
                    char pb[64]; ::inet_ntop(AF_INET, &peerIp, pb, 64);
                    fprintf(stderr, "ksengine: relay rx %zdB from peer %s:%d (chan %s)\n",
                            r - 10, pb, ntohs(peerPort),
                            it != byPeer_.end() ? "yes" : "no");
                }
                if (it != byPeer_.end() && engineKnown_) {
                    auto cit = chans_.find(it->second);
                    if (cit != chans_.end())
                        ::sendto(cit->second.fd, buf + 10, (size_t)r - 10, 0,
                                 (sockaddr*)&engine_, sizeof(engine_));
                }
            }
        }

        // datagrams from the engine's utp socket, addressed to a peer
        for (size_t i = 1; i < fds.size(); ++i) {
            if (!(fds[i].revents & POLLIN)) continue;
            sockaddr_in src{};
            socklen_t sl = sizeof(src);
            ssize_t r = ::recvfrom(fds[i].fd, buf, sizeof(buf), 0, (sockaddr*)&src, &sl);
            if (r <= 0) continue;
            std::lock_guard<std::mutex> lk(mtx_);
            Chan* ch = nullptr;
            for (auto& [p, c] : chans_) if (c.fd == fds[i].fd) { ch = &c; break; }
            if (!ch) continue;
            if (!engineKnown_) { engine_ = src; engineKnown_ = true;
                char eb[64]; ::inet_ntop(AF_INET, &src.sin_addr, eb, 64);
                fprintf(stderr, "ksengine: relay sees engine at %s:%d\n", eb, ntohs(src.sin_port)); }
            static int dbgN = 0;
            if (dbgN < 20) { ++dbgN;
                char pb[64]; ::inet_ntop(AF_INET, &ch->ip, pb, 64);
                fprintf(stderr, "ksengine: relay fwd %zdB -> peer %s:%d\n", r, pb, ch->port); }
            // socks5 udp request header
            uint8_t hdr[10] = {0, 0, 0, 1};
            memcpy(hdr + 4, &ch->ip, 4);
            uint16_t np = htons(ch->port);
            memcpy(hdr + 8, &np, 2);
            iovec iov[2] = {{hdr, 10}, {buf, (size_t)r}};
            msghdr mh{};
            mh.msg_name = &assoc_;
            mh.msg_namelen = sizeof(assoc_);
            mh.msg_iov = iov;
            mh.msg_iovlen = 2;
            ::sendmsg(data_, &mh, 0);
        }
    }
}

} // namespace ks
