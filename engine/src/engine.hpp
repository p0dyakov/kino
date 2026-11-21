#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <sys/types.h>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <libtorrent/session.hpp>
#include <libtorrent/torrent_handle.hpp>
#include <libtorrent/file_storage.hpp>

namespace ks {

class PeerRelay;
class Transmuxer;

// One torrent that is being streamed. The engine keeps exactly one
// "hot" session; starting playback stops the previous one.
struct StreamSession {
    std::string id;
    std::string infoHash;
    std::string title;
    int requestedFileIdx = -1;
    std::string fileQuery;   // regex on file paths — episode pick inside season packs
    lt::torrent_handle handle;

    // filled once metadata arrives
    std::atomic<bool> metadataReady{false};
    std::atomic<bool> dead{false};
    std::string error;
    int fileIndex = -1;
    int64_t fileOffset = 0; // absolute offset of file inside torrent
    int64_t fileSize = 0;
    int pieceLength = 0;
    int firstPiece = 0;
    int lastPiece = 0;
    std::string filePathOnDisk;
    std::string fileName;
    std::string mime;
    int diskFd = -1;

    std::mutex mtx;
    std::condition_variable cv;
    std::unordered_set<int> pendingPieces;

    std::atomic<int64_t> playhead{0};
    std::atomic<int64_t> lastSchedUs{0};
    std::atomic<int64_t> lastDataAt{0};

    bool isDownload = false; // background download — survives new play sessions
    int64_t addedAtUs = 0;   // when addTorrent ran (for proxy fallback timing)
    std::atomic<bool> catalogued{false};
    std::atomic<bool> warmOnly{false};

    std::mutex targetsMtx;
    std::vector<std::pair<int, std::string>> downloadTargets;
    std::atomic<int> scheduledDownloadFile{-1};

    // second file pulled alongside the play target — next episode inside
    // the same season pack while the current one is playing
    int prefetchFileIdx = -1;
    std::string prefetchFileQuery;
};

struct FileEntry {
    int index;
    std::string path;
    int64_t size;
    bool selected;
};

class Engine {
public:
    Engine();
    ~Engine();

    Engine(const Engine&) = delete;
    Engine& operator=(const Engine&) = delete;

    // Add a torrent for streaming. Returns session id immediately; metadata
    // is fetched in background — poll waitMetadata().
    std::shared_ptr<StreamSession> addTorrent(const std::string& infoHash,
                                              const std::vector<std::string>& trackers,
                                              const std::string& title,
                                              int fileIdx,
                                              bool isDownload = false,
                                              const std::string& fileQuery = "",
                                              bool warmOnly = false);

    std::shared_ptr<StreamSession> get(const std::string& id);
    // reader jumped to a new offset — recenter the download window there now
    void noteSeek(const std::shared_ptr<StreamSession>& s, int64_t fileOff);
    // (re)select which file inside the torrent the session streams
    bool chooseFile(const std::shared_ptr<StreamSession>& s);
    // mark the play file + optional prefetch file as the only downloaded ones
    void applyFilePriorities(const std::shared_ptr<StreamSession>& s);
    std::vector<std::string> sessionIds() {
        std::lock_guard<std::mutex> lk(mtx_);
        std::vector<std::string> out;
        out.reserve(sessions_.size());
        for (auto& [id, s] : sessions_) out.push_back(id);
        return out;
    }
    bool waitMetadata(const std::shared_ptr<StreamSession>& s, int timeoutSec);

    std::vector<FileEntry> files(const std::shared_ptr<StreamSession>& s);

    // Serve [off, off+len) of the selected file into sink(buf,n).
    // Blocks until pieces arrive; returns false on hard failure.
    bool readRange(const std::shared_ptr<StreamSession>& s, int64_t off, int64_t len,
                   const std::function<bool(const char*, size_t)>& sink);

    // Blocking random read: fills buf with [off, off+n) of the file.
    // Returns bytes actually read (0 on EOF/failure).
    int64_t readAt(const std::shared_ptr<StreamSession>& s, int64_t off, uint8_t* buf, int64_t n);

    void stop(const std::string& id);   // remove torrent, keep files on disk
    void stopAll();

    // MSE playback: remuxer over the selected file (created lazily, probed once).
    std::shared_ptr<Transmuxer> transmuxer(const std::shared_ptr<StreamSession>& s);
    void cancelTransmux(const std::string& id);

    std::string statusJson(const std::shared_ptr<StreamSession>& s);
    std::string targetStatusJson(const std::shared_ptr<StreamSession>& s,
                                 int fileIdx, const std::string& fileQuery,
                                 bool strict = false);
    void setDownloadTargets(const std::shared_ptr<StreamSession>& s,
                            std::vector<std::pair<int, std::string>> targets);

    const std::string& cacheDir() const { return cacheDir_; }
    int portValue() const { return port_; }
    void setPort(int p) { port_ = p; }

    // called lazily when a session stalls without metadata — brings the
    // local socks proxy up so enableProxy() can route through it
    std::function<void()> spawnProxy_;

    // signal-safe: sets a flag the alert thread drains into resume saves
    void requestQuit() { quitRequested_.store(1); }

private:
    void alertLoop();
    void onMetadata(const std::shared_ptr<StreamSession>& s);
    void scheduleWindow(const std::shared_ptr<StreamSession>& s, int64_t fileOff);
    bool ensurePieces(const std::shared_ptr<StreamSession>& s, int first, int last);
    int openFd(const std::shared_ptr<StreamSession>& s);
    void requestResumeSave(const std::shared_ptr<StreamSession>& s);
    std::string resumePath(const std::string& infoHash) const;
    void enableProxy();
    void boostPeers(std::shared_ptr<StreamSession> s, std::vector<std::string> trackers);
    void applyHeadTail(const std::shared_ptr<StreamSession>& s, int pick,
                       const lt::file_storage& fs);
    void reapplyPieceOverrides(const std::shared_ptr<StreamSession>& s);
    void mirrorLoop();

    lt::session ses_;
    std::shared_ptr<PeerRelay> relay_;
    std::mutex relayMtx_;
    std::string cacheDir_;
    std::atomic<bool> proxyOn_{false};
    std::mutex mtx_;
    std::unordered_map<std::string, std::shared_ptr<StreamSession>> sessions_;
    std::unordered_map<std::string, std::weak_ptr<StreamSession>> byHash_;
    std::unordered_map<std::string, std::shared_ptr<Transmuxer>> transmuxers_;
    std::thread alertThread_;
    std::thread mirrorThread_;
    std::deque<std::weak_ptr<StreamSession>> mirrorJobs_;
    std::mutex mirrorMtx_;
    std::condition_variable mirrorCv_;
    std::atomic<bool> running_{true};
    std::atomic<int> quitRequested_{0};
    bool verbose_ = false;
    int port_ = 0;
};

} // namespace ks
