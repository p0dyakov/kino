#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "../vendor/json.hpp"

struct AVFormatContext;
struct AVCodecContext;
struct AVIOContext;
typedef struct SwrContext SwrContext;

namespace ks {

class Engine;
struct StreamSession;

// Random-access reader over torrent pieces; backs the ffmpeg AVIOContext.
class PieceReader {
public:
    PieceReader(Engine& e, std::shared_ptr<StreamSession> s);
    int64_t size() const;
    int64_t pos() const { return pos_; }
    int read(uint8_t* buf, int n);
    int64_t seek(int64_t off);

private:
    Engine& eng_;
    std::shared_ptr<StreamSession> s_;
    std::vector<uint8_t> buf_;
    int64_t pos_ = 0;
};

// Remuxes the selected torrent file to fragmented MP4 for MSE playback.
// Video is copied bitstream-exact; non-AAC audio is transcoded to AAC.
class Transmuxer {
public:
    Transmuxer(Engine& e, std::shared_ptr<StreamSession> s);
    ~Transmuxer();

    // Probe input (demux). Blocks on piece fetches; call once before tracks().
    bool open();
    bool isOpen() const { return ifmt_ != nullptr; }

    nlohmann::json tracks();

    // Produce fMP4 for MSE starting at `t` seconds with audio track `audioIdx`
    // (index into tracks().audio). Streams into sink until EOF or cancelled.
    bool produce(double t, int audioIdx,
                 const std::function<bool(const char*, size_t)>& sink);

    void cancel() { cancelled_.store(true); }

private:
    struct AudioPipe {
        AVCodecContext* dec = nullptr;
        AVCodecContext* enc = nullptr;
        SwrContext* swr = nullptr;
        int outStreamIdx = -1;
        int64_t delaySamples = 0;
        bool opened = false;
    };
    AudioPipe pipe_;

    bool openAudioPipe(int inStreamIdx);
    void closeAudioPipe();
    int pickAudio(int requested) const;

    Engine& eng_;
    std::shared_ptr<StreamSession> s_;
    std::unique_ptr<PieceReader> reader_;
    AVFormatContext* ifmt_ = nullptr;
    AVIOContext* inIo_ = nullptr;
    int videoInIdx_ = -1;

    std::mutex produceMtx_;
    std::atomic<bool> cancelled_{false};
};

} // namespace ks
