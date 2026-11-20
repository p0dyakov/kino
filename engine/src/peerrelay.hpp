#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#include <unordered_map>
#include <netinet/in.h>

namespace ks {

// uTP traffic can't reach international peers — the ISP edge drops new
// outbound flows that look like bittorrent. This relay wraps every uTP
// datagram in a SOCKS5 UDP packet and pushes it through the local xray
// socks port; from the VLESS exit the packet goes to the real peer over
// plain UDP, where no DPI is watching.
//
// Each remote peer gets its own loopback socket (127.0.0.1:ephemeral).
// libtorrent is told to connect_peer() that loopback endpoint, so its uTP
// state machine sees a perfectly normal peer at a loopback address; we do
// the translation both ways.
class PeerRelay {
public:
    ~PeerRelay() { stop(); }

    // opens a socks5 UDP ASSOCIATE against 127.0.0.1:port (xray).
    // false when the proxy is not there — callers then fall back to direct.
    bool start(uint16_t socksPort);
    void stop();
    bool active() const { return running_.load(); }

    // assigns a loopback endpoint for this peer (idempotent per peer);
    // returns its port, or 0 when the pool is exhausted
    uint16_t wrap(uint32_t peerIpNetOrder, uint16_t peerPort);

private:
    void loop();

    int ctrl_ = -1;        // tcp control — association lives while it's open
    int data_ = -1;        // udp socket used with the associate
    sockaddr_in assoc_{};  // address xray told us to send datagrams to

    struct Chan { int fd = -1; uint32_t ip; uint16_t port; };
    std::unordered_map<uint16_t, Chan> chans_;          // local port -> peer
    std::unordered_map<uint64_t, uint16_t> byPeer_;     // peerKey -> local port
    sockaddr_in engine_{};                               // engine utp socket addr
    bool engineKnown_ = false;

    std::mutex mtx_;
    std::thread thr_;
    std::atomic<bool> running_{false};
};

} // namespace ks
