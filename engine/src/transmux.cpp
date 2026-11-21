#include "transmux.hpp"
#include "engine.hpp"

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/channel_layout.h>
#include <libavutil/dict.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
}

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <unistd.h>

namespace ks {

using nlohmann::json;

// ---------------------------------------------------------------------------
// PieceReader — AVIO over torrent pieces
// ---------------------------------------------------------------------------

PieceReader::PieceReader(Engine& e, std::shared_ptr<StreamSession> s)
    : eng_(e), s_(std::move(s)) {}

int64_t PieceReader::size() const { return s_->fileSize; }

int PieceReader::read(uint8_t* buf, int n) {
    if (s_->dead) return AVERROR_EXIT;
    int64_t got = eng_.readAt(s_, pos_, buf, n);
    if (got <= 0) return AVERROR_EOF;
    pos_ += got;
    return int(got);
}

int64_t PieceReader::seek(int64_t off) {
    if (off < 0) off = 0;
    if (off > s_->fileSize) off = s_->fileSize;
    pos_ = off;
    // recenter the download window NOW — the demuxer will start reading
    // here immediately, so pieces around this offset outrank the old spot
    eng_.noteSeek(s_, off);
    return pos_;
}

static int ioRead(void* opaque, uint8_t* buf, int n) {
    return static_cast<PieceReader*>(opaque)->read(buf, n);
}
static int64_t ioSeek(void* opaque, int64_t off, int whence) {
    auto* r = static_cast<PieceReader*>(opaque);
    if (whence == AVSEEK_SIZE) return r->size();
    if (whence == SEEK_SET) return r->seek(off);
    if (whence == SEEK_CUR) return r->seek(r->pos() + off);
    if (whence == SEEK_END) return r->seek(r->size() + off);
    return AVERROR(EINVAL);
}

// ---------------------------------------------------------------------------
// codec tag strings for MSE mimetypes
// ---------------------------------------------------------------------------

static std::string videoCodecTag(const AVCodecParameters* p) {
    char buf[64];
    switch (p->codec_id) {
        case AV_CODEC_ID_H264:
            if (p->extradata && p->extradata_size >= 4 && p->extradata[0] == 1) {
                snprintf(buf, sizeof buf, "avc1.%02X%02X%02X",
                         p->extradata[1], p->extradata[2], p->extradata[3]);
            } else {
                snprintf(buf, sizeof buf, "avc1.64001F");
            }
            return buf;
        case AV_CODEC_ID_HEVC: {
            int lv = p->level > 0 ? p->level : 153;
            snprintf(buf, sizeof buf, "hvc1.1.6.L%d.B0", lv);
            return buf;
        }
        case AV_CODEC_ID_AV1:
            return "av01.0.08M.08";
        case AV_CODEC_ID_VP9:
            return "vp09.00.10.08";
        case AV_CODEC_ID_MPEG2VIDEO:
            return "mp4v.20.8";
        default:
            return avcodec_get_name(p->codec_id);
    }
}

static bool videoMseOk(AVCodecID id) {
    switch (id) {
        case AV_CODEC_ID_H264:
        case AV_CODEC_ID_HEVC:
        case AV_CODEC_ID_AV1:
        case AV_CODEC_ID_VP9:
            return true;
        default:
            return false;
    }
}

// ---------------------------------------------------------------------------
// Transmuxer
// ---------------------------------------------------------------------------

Transmuxer::Transmuxer(Engine& e, std::shared_ptr<StreamSession> s)
    : eng_(e), s_(std::move(s)) {}

Transmuxer::~Transmuxer() {
    closeAudioPipe();
    if (ifmt_) avformat_close_input(&ifmt_);
    if (inIo_) {
        // pb buffer is owned by the context — freeing ctx frees both
        avio_context_free(&inIo_);
    }
}

bool Transmuxer::open() {
    if (ifmt_) return true;
    reader_ = std::make_unique<PieceReader>(eng_, s_);

    uint8_t* buf = static_cast<uint8_t*>(av_malloc(1 << 16));
    inIo_ = avio_alloc_context(buf, 1 << 16, 0, reader_.get(), ioRead, nullptr, ioSeek);
    if (!inIo_) { av_free(buf); return false; }

    ifmt_ = avformat_alloc_context();
    ifmt_->pb = inIo_;
    ifmt_->flags |= AVFMT_FLAG_CUSTOM_IO;
    ifmt_->probesize = 4 << 20;
    ifmt_->max_analyze_duration = 4 * AV_TIME_BASE;
    ifmt_->max_ts_probe = 20;

    if (avformat_open_input(&ifmt_, nullptr, nullptr, nullptr) < 0) {
        ifmt_ = nullptr;
        avio_context_free(&inIo_);
        inIo_ = nullptr;
        return false;
    }
    // probing may return short; stream info failures are non-fatal for mkv
    if (avformat_find_stream_info(ifmt_, nullptr) < 0) {
        // continue — mkv headers usually carry codec params already
    }
    videoInIdx_ = av_find_best_stream(ifmt_, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0);
    return videoInIdx_ >= 0;
}

json Transmuxer::tracks() {
    json j;
    if (!ifmt_) return j;
    auto* vp = ifmt_->streams[videoInIdx_]->codecpar;
    j["video"] = {
        {"codec", avcodec_get_name(vp->codec_id)},
        {"tag", videoCodecTag(vp)},
        {"width", vp->width},
        {"height", vp->height},
        {"mse", videoMseOk(vp->codec_id)},
    };
    j["audio"] = json::array();
    for (unsigned i = 0; i < ifmt_->nb_streams; ++i) {
        auto* st = ifmt_->streams[i];
        if (st->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
        std::string lang = "und";
        if (auto* e = av_dict_get(st->metadata, "language", nullptr, 0))
            lang = e->value;
        std::string title;
        if (auto* e = av_dict_get(st->metadata, "title", nullptr, 0))
            title = e->value;
        j["audio"].push_back({
            {"idx", (int)i},
            {"lang", lang},
            {"title", title},
            {"codec", avcodec_get_name(st->codecpar->codec_id)},
            {"channels", st->codecpar->ch_layout.nb_channels},
            {"default", st->disposition & AV_DISPOSITION_DEFAULT ? true : false},
        });
    }
    j["duration"] = ifmt_->duration > 0 ? double(ifmt_->duration) / AV_TIME_BASE : -1;
    return j;
}

int Transmuxer::pickAudio(int requested) const {
    // requested is an input stream index; fall back to default/first audio
    if (requested >= 0 && requested < (int)ifmt_->nb_streams &&
        ifmt_->streams[requested]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO)
        return requested;
    int firstAudio = -1;
    for (unsigned i = 0; i < ifmt_->nb_streams; ++i) {
        auto* st = ifmt_->streams[i];
        if (st->codecpar->codec_type != AVMEDIA_TYPE_AUDIO) continue;
        if (firstAudio < 0) firstAudio = (int)i;
        if (st->disposition & AV_DISPOSITION_DEFAULT) return (int)i;
    }
    return firstAudio;
}

bool Transmuxer::openAudioPipe(int inStreamIdx) {
    closeAudioPipe();
    if (inStreamIdx < 0) return false;
    auto* par = ifmt_->streams[inStreamIdx]->codecpar;

    const AVCodec* decCodec = avcodec_find_decoder(par->codec_id);
    const AVCodec* encCodec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!decCodec || !encCodec) return false;

    AudioPipe& ap = pipe_;
    ap.dec = avcodec_alloc_context3(decCodec);
    if (avcodec_parameters_to_context(ap.dec, par) < 0) return false;
    ap.dec->pkt_timebase = ifmt_->streams[inStreamIdx]->time_base;
    if (avcodec_open2(ap.dec, decCodec, nullptr) < 0) return false;
    // some files carry a bare channel count with no layout — guessing one keeps
    // swr's downmix from producing unmapped garbage
    if (ap.dec->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC) {
        int nch = ap.dec->ch_layout.nb_channels;
        if (nch <= 0) nch = par->ch_layout.nb_channels;
        av_channel_layout_default(&ap.dec->ch_layout, std::max(nch, 1));
    }

    ap.enc = avcodec_alloc_context3(encCodec);
    AVChannelLayout stereo;
    av_channel_layout_default(&stereo, 2);
    av_channel_layout_copy(&ap.enc->ch_layout, &stereo);
    ap.enc->sample_rate = 48000;
    ap.enc->sample_fmt = AV_SAMPLE_FMT_FLTP;
    {
        const AVSampleFormat* fmts = nullptr;
        int nfmt = 0;
        if (avcodec_get_supported_config(ap.enc, encCodec,
                AV_CODEC_CONFIG_SAMPLE_FORMAT, 0,
                (const void**)&fmts, &nfmt) == 0 && nfmt > 0)
            ap.enc->sample_fmt = fmts[0];
    }
    ap.enc->bit_rate = 192000;
    ap.enc->time_base = AVRational{1, 48000};
    if (avcodec_open2(ap.enc, encCodec, nullptr) < 0) return false;

    if (swr_alloc_set_opts2(&ap.swr,
            &ap.enc->ch_layout, ap.enc->sample_fmt, ap.enc->sample_rate,
            &ap.dec->ch_layout, ap.dec->sample_fmt, ap.dec->sample_rate,
            0, nullptr) < 0)
        return false;
    // 5.1→stereo sums channels at ~2.4× — without loudness protection the
    // float output exceeds 1.0 and clips hard inside the AAC stream
    av_opt_set_double(ap.swr, "rematrix_maxval", 1.0, 0);
    if (swr_init(ap.swr) < 0) return false;
    ap.opened = true;
    return true;
}

void Transmuxer::closeAudioPipe() {
    if (pipe_.dec) avcodec_free_context(&pipe_.dec);
    if (pipe_.enc) avcodec_free_context(&pipe_.enc);
    if (pipe_.swr) swr_free(&pipe_.swr);
    pipe_ = AudioPipe{};
}

// output AVIO → HTTP sink
struct OutSink {
    std::function<bool(const char*, size_t)> write;
    std::atomic<bool>* cancelled;
    std::chrono::steady_clock::time_point t0 = std::chrono::steady_clock::now();
    int64_t bytes = 0;
};
static int ioWrite(void* opaque, const uint8_t* buf, int n) {
    auto* o = static_cast<OutSink*>(opaque);
    if (o->cancelled && o->cancelled->load()) return AVERROR_EXIT;
    // pace output — a fully cached file would otherwise blast through at
    // disk speed and the webview's MSE queue balloons into gigabytes
    // (GC pressure freezes the UI). 28 MB/s clears any 4K bitrate.
    o->bytes += n;
    constexpr double kRate = 28.0 * 1024 * 1024;
    double el = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - o->t0).count();
    int64_t aheadUs = (int64_t)((o->bytes - kRate * el) / kRate * 1e6);
    while (aheadUs > 0 && !(o->cancelled && o->cancelled->load())) {
        int slice = (int)std::min<int64_t>(aheadUs, 20000);
        usleep(slice);
        aheadUs -= slice;
    }
    // client gone / broken pipe → mark cancelled so the read loop stops
    // pulling pieces instead of running to EOF pointlessly
    if (!o->write(reinterpret_cast<const char*>(buf), (size_t)n)) {
        if (o->cancelled) o->cancelled->store(true);
        return AVERROR_EXIT;
    }
    return n;
}

bool Transmuxer::produce(double t, int audioIdx,
                         const std::function<bool(const char*, size_t)>& sink) {
    std::lock_guard<std::mutex> lk(produceMtx_);
    cancelled_ = false;
    if (!open()) return false;

    int aIn = pickAudio(audioIdx);
    auto* vin = ifmt_->streams[videoInIdx_];
    auto* ain = aIn >= 0 ? ifmt_->streams[aIn] : nullptr;
    auto* apar = ain ? ain->codecpar : nullptr;
    bool audioCopy = apar && apar->codec_id == AV_CODEC_ID_AAC;

    AVFormatContext* ofmt = nullptr;
    if (avformat_alloc_output_context2(&ofmt, nullptr, "mp4", nullptr) < 0 || !ofmt) {
        fprintf(stderr, "transmux: alloc output ctx failed\n");
        return false;
    }
    bool ok = false;
    AVIOContext* outIo = nullptr;
    AVPacket* pkt = av_packet_alloc();
    AVFrame* frame = av_frame_alloc();
    AVFrame* outFrame = av_frame_alloc();
    AVFrame* encFrame = av_frame_alloc();
    AVPacket* audioPacket = av_packet_alloc();
    AVAudioFifo* fifo = nullptr;

    do {
        if (!pkt || !frame || !outFrame || !encFrame || !audioPacket) break;
        AVStream* vout = avformat_new_stream(ofmt, nullptr);
        if (!vout) { fprintf(stderr, "transmux: new video stream failed\n"); break; }
        avcodec_parameters_copy(vout->codecpar, vin->codecpar);
        vout->codecpar->codec_tag = 0;
        vout->time_base = vin->time_base;

        AVStream* aout = nullptr;
        if (ain) {
            aout = avformat_new_stream(ofmt, nullptr);
            if (!aout) { fprintf(stderr, "transmux: new audio stream failed\n"); break; }
            if (audioCopy) {
                avcodec_parameters_copy(aout->codecpar, apar);
                aout->codecpar->codec_tag = 0;
                aout->time_base = ain->time_base;
            } else {
                if (!openAudioPipe(aIn)) { fprintf(stderr, "transmux: audio pipe failed\n"); break; }
                fifo = av_audio_fifo_alloc(pipe_.enc->sample_fmt,
                    pipe_.enc->ch_layout.nb_channels, pipe_.enc->frame_size);
                if (!fifo) break;
                avcodec_parameters_from_context(aout->codecpar, pipe_.enc);
                aout->time_base = pipe_.enc->time_base;
            }
        }

        OutSink os{sink, &cancelled_};
        uint8_t* obuf = static_cast<uint8_t*>(av_malloc(1 << 18));
        outIo = avio_alloc_context(obuf, 1 << 18, 1, &os, nullptr, ioWrite, nullptr);
        if (!outIo) { av_free(obuf); fprintf(stderr, "transmux: avio alloc failed\n"); break; }
        ofmt->pb = outIo;
        ofmt->flags |= AVFMT_FLAG_CUSTOM_IO;

        // seek before header so all muxed packets land on the natural timeline;
        // always seek — probing leaves the read position mid-stream
        bool skipToKey = false;
        if (av_seek_frame(ifmt_, -1, (int64_t)(std::max(t, 0.0) * AV_TIME_BASE),
                          AVSEEK_FLAG_BACKWARD) < 0 && t > 0) {
            // no usable index (mkv cues live at file end and aren't downloaded
            // yet) — byte-seek an estimate ahead of the target and resync;
            // undershoots on purpose so packets before t cover the playhead
            double dur = ifmt_->duration > 0
                ? (double)ifmt_->duration / (double)AV_TIME_BASE : 0;
            if (dur > 0 && s_->fileSize > 0) {
                int64_t est = (int64_t)(t / dur * (double)s_->fileSize) - (48LL << 20);
                est = std::clamp<int64_t>(est, 0, s_->fileSize);
                if (avio_seek(inIo_, est, SEEK_SET) >= 0) {
                    avformat_flush(ifmt_);
                    skipToKey = true;
                }
            }
        }

        AVDictionary* opts = nullptr;
        // frag_every_frame: flush a moof+mdat per sample — first playable
        // data reaches MSE after the first pieces instead of after a whole
        // GOP (~15-30 MB of 4K input) — critical for fast seek recovery
        av_dict_set(&opts, "movflags",
                    "frag_every_frame+empty_moov+default_base_moof+omit_tfhd_offset", 0);
        if (avformat_write_header(ofmt, &opts) < 0) {
            av_dict_free(&opts);
            fprintf(stderr, "transmux: write_header failed\n");
            break;
        }
        av_dict_free(&opts);

        ok = true;
        AVRational inVtb = vin->time_base;
        AVRational outVtb = vout->time_base;
        AVRational inAtb = ain ? ain->time_base : AVRational{1, 1};
        int64_t nextAudioPts = AV_NOPTS_VALUE;
        const auto drainEncoder = [&] {
            for (;;) {
                const int r = avcodec_receive_packet(pipe_.enc, audioPacket);
                if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return true;
                if (r < 0) return false;
                av_packet_rescale_ts(audioPacket, pipe_.enc->time_base, aout->time_base);
                audioPacket->stream_index = aout->index;
                // av_write_frame, not interleaved: under frag_every_frame the
                // interleaver stamps every second audio fragment with the
                // previous fragment's tfdt — MSE then plays overlapping
                // ranges and the audio crackles
                if (av_write_frame(ofmt, audioPacket) < 0) return false;
            }
        };
        const auto encodeFifo = [&](bool flush) {
            const int frameSize = pipe_.enc->frame_size;
            while (av_audio_fifo_size(fifo) >= frameSize ||
                   (flush && av_audio_fifo_size(fifo) > 0)) {
                av_frame_unref(encFrame);
                encFrame->nb_samples = std::min(frameSize, av_audio_fifo_size(fifo));
                encFrame->format = pipe_.enc->sample_fmt;
                encFrame->sample_rate = pipe_.enc->sample_rate;
                if (av_channel_layout_copy(&encFrame->ch_layout, &pipe_.enc->ch_layout) < 0 ||
                    av_frame_get_buffer(encFrame, 0) < 0 ||
                    av_audio_fifo_read(fifo,
                        reinterpret_cast<void**>(encFrame->extended_data),
                        encFrame->nb_samples) != encFrame->nb_samples)
                    return false;
                encFrame->pts = nextAudioPts;
                nextAudioPts += encFrame->nb_samples;
                if (avcodec_send_frame(pipe_.enc, encFrame) < 0 || !drainEncoder())
                    return false;
            }
            return true;
        };
        const auto convertAudio = [&](const AVFrame* input) -> int {
            const int count = input ? input->nb_samples : 0;
            const int capacity = swr_get_out_samples(pipe_.swr, count);
            if (capacity <= 0) return capacity;
            av_frame_unref(outFrame);
            outFrame->nb_samples = capacity;
            outFrame->format = pipe_.enc->sample_fmt;
            outFrame->sample_rate = pipe_.enc->sample_rate;
            if (av_channel_layout_copy(&outFrame->ch_layout, &pipe_.enc->ch_layout) < 0 ||
                av_frame_get_buffer(outFrame, 0) < 0)
                return AVERROR(ENOMEM);
            const int n = swr_convert(pipe_.swr, outFrame->extended_data, capacity,
                input ? const_cast<const uint8_t**>(input->extended_data) : nullptr,
                count);
            if (n <= 0) return n;
            if (av_audio_fifo_write(fifo,
                    reinterpret_cast<void**>(outFrame->extended_data), n) != n ||
                !encodeFifo(false))
                return AVERROR_EXTERNAL;
            return n;
        };
        const auto drainDecoder = [&] {
            for (;;) {
                const int r = avcodec_receive_frame(pipe_.dec, frame);
                if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) return true;
                if (r < 0) return false;
                if (nextAudioPts == AV_NOPTS_VALUE)
                    nextAudioPts = frame->best_effort_timestamp == AV_NOPTS_VALUE
                        ? 0
                        : av_rescale_q(frame->best_effort_timestamp, inAtb,
                              pipe_.enc->time_base);
                const int n = convertAudio(frame);
                av_frame_unref(frame);
                if (n < 0) return false;
            }
        };
        long nPkts = 0;
        int rc = 0;

        while (!cancelled_.load() && (rc = av_read_frame(ifmt_, pkt)) >= 0) {
            ++nPkts;
            if (skipToKey) {
                // byte-seek fallback: resync output at the first video keyframe
                if (pkt->stream_index == videoInIdx_ && (pkt->flags & AV_PKT_FLAG_KEY))
                    skipToKey = false;
                else { av_packet_unref(pkt); continue; }
            }
            if (pkt->stream_index == videoInIdx_) {
                pkt->pts = av_rescale_q_rnd(pkt->pts, inVtb, outVtb,
                            (AVRounding)(AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX));
                pkt->dts = av_rescale_q_rnd(pkt->dts, inVtb, outVtb,
                            (AVRounding)(AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX));
                pkt->duration = av_rescale_q(pkt->duration, inVtb, outVtb);
                pkt->pos = -1;
                pkt->stream_index = vout->index;
                av_write_frame(ofmt, pkt);
            } else if (ain && pkt->stream_index == aIn) {
                if (audioCopy) {
                    av_packet_rescale_ts(pkt, inAtb, aout->time_base);
                    pkt->pos = -1;
                    pkt->stream_index = aout->index;
                    av_write_frame(ofmt, pkt);
                } else if (avcodec_send_packet(pipe_.dec, pkt) != 0 || !drainDecoder()) {
                    if (!cancelled_.load())
                        fprintf(stderr, "transmux: audio conversion failed\n");
                    ok = false;
                    break;
                }
            }
            av_packet_unref(pkt);
        }
        fprintf(stderr, "transmux: produce t=%.0f done — %ld pkts, rc=%d, cancelled=%d\n",
                t, nPkts, rc, cancelled_.load());

        if (fifo && ok && !cancelled_.load()) {
            bool flushed = avcodec_send_packet(pipe_.dec, nullptr) >= 0 && drainDecoder();
            int n = 0;
            if (flushed) { while ((n = convertAudio(nullptr)) > 0) {} }
            if (!flushed || n < 0 || !encodeFifo(true) ||
                avcodec_send_frame(pipe_.enc, nullptr) < 0 || !drainEncoder())
                ok = false;
        }

        av_write_trailer(ofmt);
    } while (false);

    if (outIo) avio_context_free(&outIo);
    if (ofmt) avformat_free_context(ofmt);
    if (fifo) av_audio_fifo_free(fifo);
    av_packet_free(&audioPacket);
    av_frame_free(&encFrame);
    av_packet_free(&pkt);
    av_frame_free(&frame);
    av_frame_free(&outFrame);
    closeAudioPipe();
    return ok;
}

} // namespace ks
