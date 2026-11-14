"""Local voice synthesis for the companion (Qwen3-TTS Base, voice cloning).

Started and stopped by hub together with the AI engine; listens on 127.0.0.1 only.
The model stays in RAM and only moves to the GPU for the duration of a synthesis, so the
LLM and the voice can take turns on a small GPU.

POST /synthesize {"text", "register", "out"} -> {"durationMs"}
GET  /health -> {"ok": true}
"""
import argparse
import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

# Above this GPU temperature a synthesis first pauses to let the card cool down, then runs
# anyway: a voice message is a short burst, and this laptop can idle above the threshold.
MAX_GPU_TEMP = 80
COOL_DOWN_TIMEOUT_S = 45
# Natural pacing: slightly faster than the raw output, long pauses capped.
POSTPROCESS = "silenceremove=stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB:stop_silence=0.4,atempo=1.06"


def gpu_temp() -> int:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=5).stdout
        return int(out.strip().splitlines()[0])
    except Exception:
        return 0


class Voice:
    def __init__(self, model_id: str, refs: dict[str, tuple[str, str]]):
        self.model_id = model_id
        self.refs = refs
        self.model = None
        self.prompts: dict[str, object] = {}
        self.lock = threading.Lock()

    def _move(self, device: str) -> None:
        self.model.model.to(device)
        self.model.device = torch.device(device)
        # The audio codec is a plain wrapper, not a submodule: it has to follow explicitly.
        codec = self.model.model.speech_tokenizer
        codec.model.to(device)
        codec.device = torch.device(device)
        if device == "cpu":
            torch.cuda.empty_cache()

    def _load(self) -> None:
        if self.model is not None:
            return
        self.model = Qwen3TTSModel.from_pretrained(self.model_id, device_map="cpu", dtype=torch.bfloat16)
        self._move("cuda:0")
        for register, (audio, text) in self.refs.items():
            self.prompts[register] = self.model.create_voice_clone_prompt(ref_audio=audio, ref_text=text)
        self._move("cpu")

    def synthesize(self, text: str, register: str, out: str) -> int:
        with self.lock:
            self._load()
            deadline = time.time() + COOL_DOWN_TIMEOUT_S
            while gpu_temp() > MAX_GPU_TEMP and time.time() < deadline:
                time.sleep(2)
            prompt = self.prompts.get(register) or self.prompts["normal"]
            self._move("cuda:0")
            try:
                wavs, sr = self.model.generate_voice_clone(text=text, language="French", voice_clone_prompt=prompt,
                                                           max_new_tokens=4096)
            finally:
                self._move("cpu")

        with tempfile.NamedTemporaryFile(suffix=".wav") as raw:
            sf.write(raw.name, wavs[0], sr)
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", raw.name, "-af", POSTPROCESS,
                            "-c:a", "libopus", "-b:a", "48k", out], check=True)
        info = sf.info(out)
        return round(info.duration * 1000)


def make_handler(voice: Voice):
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                return self._reply(200, {"ok": True})
            self._reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/synthesize":
                return self._reply(404, {"error": "not found"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                duration = voice.synthesize(req["text"], req.get("register", "normal"), req["out"])
                self._reply(200, {"durationMs": duration})
            except Exception as err:
                self._reply(500, {"error": str(err)})

        def log_message(self, *_):
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--config", required=True, help="JSON: {model, refs: {register: {audio, text}}}")
    args = parser.parse_args()

    config = json.loads(args.config)
    refs = {name: (os.path.expanduser(r["audio"]), r["text"]) for name, r in config["refs"].items()}
    voice = Voice(config["model"], refs)
    # Single-threaded on purpose: syntheses are serialized anyway (one GPU).
    HTTPServer(("127.0.0.1", args.port), make_handler(voice)).serve_forever()


if __name__ == "__main__":
    main()
