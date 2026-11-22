"""Local transcription with faster-whisper. Prints JSON lines to stdout:
{"progress": 0.42}  ...  {"words": [{"start": 0.1, "end": 0.4, "text": "שלום"}, ...], "language": "he"}
"""
import argparse
import json
import os
import sys
import threading
import time


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def cache_bytes(repo):
    """Bytes of this model already in the Hugging Face cache (finished and partial files)."""
    try:
        from huggingface_hub.constants import HF_HUB_CACHE
        d = os.path.join(HF_HUB_CACHE, "models--" + repo.replace("/", "--"), "blobs")
        return sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d)) if os.path.isdir(d) else 0
    except Exception:
        return 0


# model size or repository -> pinned Hugging Face revision (Systran/faster-whisper-<size>, ivrit-ai), and the SHA-256 of its model.bin.
# Every size the app offers is pinned; a changed upstream repository cannot slip in.
PINNED = {
    "tiny": "d90ca5fe260221311c53c58e660288d3deb8d356",
    "base": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    "small": "536b0662742c02347bc0e980a01041f333bce120",
    "medium": "08e178d48790749d25932bbc082711ddcfdfbc4f",
    "large-v3": "edaa852ec7e145841d8ffdb056a99866b5f0a478",
    # Hebrew: the ivrit.ai fine-tune of large-v3 turbo (the default for Hebrew speech)
    "ivrit-ai/whisper-large-v3-turbo-ct2": "72ad623a37947395efcc3933132353790e5a12f5",
}
PINNED_SHA256 = {
    "tiny": "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1",
    "base": "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9",
    "small": "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
    "medium": "9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae",
    "large-v3": "69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1",
    "ivrit-ai/whisper-large-v3-turbo-ct2": "db2a2265aa012c16c7db9edda3d699c99f984efdd3f2e22a72a8ce7e9720f3a2",
}


def verify_model(model_path, name):
    want = PINNED_SHA256.get(name)
    if not want:
        return True
    import hashlib
    f = os.path.join(model_path, "model.bin")
    h = hashlib.sha256()
    with open(f, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    if h.hexdigest() == want:
        return True
    try:
        os.remove(os.path.realpath(f))
        os.remove(f)
    except OSError:
        pass
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--language", default="he")
    ap.add_argument("--model", default="medium")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute", default="auto")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit({"error": "faster-whisper is not installed. Run: pip install faster-whisper"})
        return 2

    device = args.device
    compute = args.compute
    if device == "auto":
        try:
            import ctranslate2
            device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
        except Exception:
            device = "cpu"
    if compute == "auto":
        compute = "float16" if device == "cuda" else "int8"

    downloading = False
    repo = None
    # the exact model files this build was tested with (a changed upstream repo cannot slip in)
    revision = PINNED.get(args.model)
    try:
        from faster_whisper.utils import _MODELS
        from huggingface_hub import try_to_load_from_cache
        if not os.path.isdir(args.model):
            repo = _MODELS.get(args.model, args.model)
            downloading = not isinstance(try_to_load_from_cache(repo, "model.bin", revision=revision), str)
    except Exception:
        pass
    state = {"stage": "download" if downloading else "load", "pos": 0.0, "total": 0.0, "dl": 0, "dlTotal": 0}
    model_path = args.model
    started = time.time()

    def heartbeat():
        # proves the work is alive even while one long audio window is being decoded
        while True:
            time.sleep(1)
            if state["stage"] == "download" and repo:
                state["dl"] = cache_bytes(repo)
            emit({"tick": round(time.time() - started, 1), "stage": state["stage"], "pos": round(state["pos"], 2), "total": round(state["total"], 2), "dl": state["dl"], "dlTotal": state["dlTotal"]})

    threading.Thread(target=heartbeat, daemon=True).start()
    emit({"progress": 0.02, "stage": state["stage"]})
    if downloading and repo:
        # first run on this PC: download the model with a visible byte count
        try:
            from huggingface_hub import HfApi
            info_ = HfApi().model_info(repo, revision=revision, files_metadata=True)
            import fnmatch
            wanted = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
            state["dlTotal"] = sum((f.size or 0) for f in info_.siblings if any(fnmatch.fnmatch(f.rfilename, w) for w in wanted))
        except Exception:
            state["dlTotal"] = 0
        from faster_whisper.utils import download_model
        try:
            model_path = download_model(args.model, revision=revision)
        except Exception as e:
            emit({"error": "download failed: %s. Check the internet connection and try again." % e})
            return 3
        if not verify_model(model_path, args.model):
            emit({"error": "the downloaded model file failed its integrity check and was removed. Try again."})
            return 3
        state["dl"] = state["dlTotal"] or cache_bytes(repo)
        state["stage"] = "load"
        emit({"progress": 0.04, "stage": "load"})
    threads = max(1, min(8, (os.cpu_count() or 4) - 1)) if device == "cpu" else 0
    # after the one-time download the model is loaded from disk only: no network call on every run
    model = WhisperModel(model_path, device=device, compute_type=compute, cpu_threads=threads, local_files_only=not downloading, revision=revision)
    state["stage"] = "transcribe"
    emit({"progress": 0.05, "stage": "transcribe"})
    language = None if args.language in ("", "auto") else args.language
    segments, info = model.transcribe(
        args.audio,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=2,
        # guards against Whisper getting stuck repeating itself on one window (seen on edited audio:
        # minutes without progress); each window is decoded independently, with few retries
        condition_on_previous_text=False,
        temperature=(0.0, 0.4, 0.8),
        no_repeat_ngram_size=3,
        max_new_tokens=224,
    )
    words = []
    total = max(info.duration, 0.01)
    state["total"] = total
    for seg in segments:
        if seg.words:
            for w in seg.words:
                text = w.word.strip()
                if text:
                    words.append({"start": round(w.start, 3), "end": round(w.end, 3), "text": text})
        elif seg.text.strip():
            words.append({"start": round(seg.start, 3), "end": round(seg.end, 3), "text": seg.text.strip(), "segment": True})
        state["pos"] = seg.end
        emit({"progress": round(min(0.99, 0.05 + 0.94 * seg.end / total), 3), "stage": "transcribe", "pos": round(seg.end, 2), "total": round(total, 2)})
    emit({"words": words, "language": info.language})
    return 0


if __name__ == "__main__":
    sys.exit(main())
