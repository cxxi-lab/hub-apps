"""Local photo generation for the companion, driving a ComfyUI install.

Started by hub with the AI engine; listens on 127.0.0.1 only. ComfyUI itself is started on
the first request (it is heavy) and its models are unloaded after each photo, so the LLM,
the voice and the images can take turns on a small GPU.

Every photo goes through two checks on the detected face, and is discarded and regenerated
when either fails (after MAX_ATTEMPTS failures no photo is returned at all):
- apparent age: never younger than MIN_APPARENT_AGE;
- resemblance: close enough to the reference face (`faceRef`), so she stays herself.
With a tagger, a picture tagged as a child or with a flat chest is discarded the same way.
Photos without a visible face (seen from behind…) skip the resemblance check only.

With a tagger (`taggerDir`: JoyTag's model.onnx and top_tags.txt, run on the CPU), the photo is
also tagged: `expect` lists groups of tags, each needing at least one match (her pose, the
point of view…). A photo missing one is regenerated once; the best one goes out anyway.

POST /generate {"scene", "level": "normal"|"soft"|"hard", "out", "negative"?, "loras"?: [{"file", "strength"}],
                "expect"?: [["tag", …], …]}
    -> {"ok": true, "tags": ["tag", …], "matched": bool} | {"error"}
GET  /health -> {"ok": true}
"""
import argparse
import json
import os
import random
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer

MIN_APPARENT_AGE = 21
# Cosine similarity to the reference face; low on purpose (laughs score lower). Turned or small
# faces are measured much less reliably, so they get a lower bar.
MIN_RESEMBLANCE = 0.35
MIN_RESEMBLANCE_TURNED = 0.22
# Nose offset from the middle of the eyes, relative to the eye distance, beyond which the face is turned.
TURNED_FACE_OFFSET = 0.25
# Face narrower than this share of the picture width counts as small.
SMALL_FACE_RATIO = 0.12
MAX_ATTEMPTS = 3
MAX_GPU_TEMP = 80
COOL_TARGET = 74
# Breathing pause between two attempts (retries after a failed check).
ATTEMPT_PAUSE_S = 10
# Regenerations for a photo that passed the face checks but misses what was asked.
MAX_EXPECT_RETRIES = 1
TAG_THRESHOLD = 0.4
# Tags that disqualify a picture outright, like a too-young apparent age.
FORBIDDEN_TAGS = {"child", "flat chest"}
COOL_MAX_WAIT_S = 60
COMFY_READY_TIMEOUT_S = 180
# Terms that must never shape a picture, whatever the scene says.
ALWAYS_NEGATIVE = ("child, children, kid, teen, teenager, underage, minor, loli, schoolgirl, school uniform, "
                   "childlike body, flat chest, ")


def gpu_temp() -> int:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=5).stdout
        return int(out.strip().splitlines()[0])
    except Exception:
        return 0


def wait_cool() -> None:
    if gpu_temp() <= MAX_GPU_TEMP:
        return
    deadline = time.time() + COOL_MAX_WAIT_S
    while gpu_temp() > COOL_TARGET and time.time() < deadline:
        time.sleep(3)


class Comfy:
    def __init__(self, cfg: dict):
        self.dir = cfg["comfyDir"]
        self.python = cfg["comfyPython"]
        self.port = cfg.get("comfyPort", 8188)
        self.url = f"http://127.0.0.1:{self.port}"
        self.proc = None

    def _up(self) -> bool:
        try:
            urllib.request.urlopen(f"{self.url}/system_stats", timeout=2)
            return True
        except Exception:
            return False

    def ensure(self) -> None:
        if self._up():
            return
        self.proc = subprocess.Popen(
            [self.python, "main.py", "--listen", "127.0.0.1", "--port", str(self.port), "--disable-auto-launch"],
            cwd=self.dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + COMFY_READY_TIMEOUT_S
        while time.time() < deadline:
            if self._up():
                return
            if self.proc.poll() is not None:
                raise RuntimeError("ComfyUI exited on startup")
            time.sleep(1)
        raise RuntimeError("ComfyUI did not become ready")

    def run(self, wf: dict, timeout: int = 600) -> str:
        wait_cool()
        body = json.dumps({"prompt": wf, "client_id": str(uuid.uuid4())}).encode()
        req = urllib.request.Request(f"{self.url}/prompt", body, {"Content-Type": "application/json"})
        pid = json.load(urllib.request.urlopen(req))["prompt_id"]
        deadline = time.time() + timeout
        while time.time() < deadline:
            hist = json.load(urllib.request.urlopen(f"{self.url}/history/{pid}"))
            if pid in hist:
                entry = hist[pid]
                if entry.get("status", {}).get("status_str") == "error":
                    raise RuntimeError("ComfyUI workflow failed")
                for node in entry["outputs"].values():
                    for img in node.get("images", []):
                        return os.path.join(self.dir, "output", img.get("subfolder", ""), img["filename"])
                raise RuntimeError("no image produced")
            time.sleep(1)
        raise TimeoutError("ComfyUI timeout")

    def free(self) -> None:
        try:
            req = urllib.request.Request(f"{self.url}/free", json.dumps({"unload_models": True, "free_memory": True}).encode(),
                                         {"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10)
        except Exception:
            pass

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()


# What each photo level must not show. "soft" is lingerie / half-naked on the explicit
# checkpoint (the safe one covers her up), never anything intimate.
LEVEL_NEGATIVE = {
    "normal": ", nude, naked, topless, nipples, exposed breasts, lingerie, underwear",
    "soft": ", fully nude, naked, topless, nipples, areola, exposed nipples, pussy, vagina, genitals, sex",
    "hard": "",
}


def build_workflow(cfg: dict, scene: str, level: str, seed: int, extra_negative: str = "", extra_loras: list | None = None) -> dict:
    nsfw = level != "normal"
    ckpt = cfg["checkpoints"]["nsfw" if nsfw else "sfw"]
    character = cfg["character"] + (", " + cfg["characterNsfw"] if nsfw and cfg.get("characterNsfw") else "")
    # Her face must be in the picture (identity, and the age / resemblance checks), unless seen from behind.
    if not is_rear_view(scene):
        scene += ", her face visible in the frame, looking at the camera"
    prompt = ", ".join(p for p in (cfg.get("triggerWord", ""), character, scene, cfg["style"]) if p)
    negative = ALWAYS_NEGATIVE + cfg.get("negative", "") + LEVEL_NEGATIVE.get(level, LEVEL_NEGATIVE["normal"])
    if extra_negative:
        negative += ", " + extra_negative
    wf = {
        "ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "latent": {"class_type": "EmptyLatentImage", "inputs": {"width": 832, "height": 1216, "batch_size": 1}},
    }
    model, clip = ["ckpt", 0], ["ckpt", 1]
    lora = cfg.get("lora")
    if lora:
        # The LoRA was trained on one checkpoint; the other one may need it stronger to keep her face.
        strength = lora.get("strengthNsfw", lora.get("strength", 0.8)) if nsfw else lora.get("strength", 0.8)
        wf["lora"] = {"class_type": "LoraLoader", "inputs": {"model": model, "clip": clip, "lora_name": lora["file"],
                      "strength_model": strength, "strength_clip": strength}}
        model, clip = ["lora", 0], ["lora", 1]
    # Concept LoRAs for this photo only (an outfit the prompt alone cannot pin down).
    for i, extra in enumerate(extra_loras or []):
        node = f"lora_extra_{i}"
        strength = float(extra.get("strength", 1.0))
        wf[node] = {"class_type": "LoraLoader", "inputs": {"model": model, "clip": clip, "lora_name": extra["file"],
                    "strength_model": strength, "strength_clip": strength}}
        model, clip = [node, 0], [node, 1]
    wf["pos"] = {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": clip}}
    wf["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": clip}}
    wf["sample"] = {"class_type": "KSampler", "inputs": {
        "model": model, "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": ["latent", 0], "seed": seed,
        "steps": 30, "cfg": 4.0 if nsfw else 5.0, "sampler_name": "dpmpp_2m_sde", "scheduler": "karras", "denoise": 1.0}}
    wf["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": ["ckpt", 2]}}
    # Face pass at higher resolution: sharper eyes, steadier identity.
    wf["det"] = {"class_type": "UltralyticsDetectorProvider", "inputs": {"model_name": "bbox/face_yolov8m.pt"}}
    wf["face"] = {"class_type": "FaceDetailer", "inputs": {
        "image": ["decode", 0], "model": model, "clip": clip, "vae": ["ckpt", 2], "guide_size": 768, "guide_size_for": True,
        "max_size": 1024, "seed": seed, "steps": 25, "cfg": 4.0, "sampler_name": "dpmpp_2m_sde", "scheduler": "karras",
        "positive": ["pos", 0], "negative": ["neg", 0], "denoise": 0.3, "feather": 5, "noise_mask": True,
        "force_inpaint": True, "bbox_threshold": 0.5, "bbox_dilation": 10, "bbox_crop_factor": 3.0,
        "sam_detection_hint": "center-1", "sam_dilation": 0, "sam_threshold": 0.93, "sam_bbox_expansion": 0,
        "sam_mask_hint_threshold": 0.7, "sam_mask_hint_use_negative": "False", "drop_size": 10,
        "bbox_detector": ["det", 0], "wildcard": "", "cycle": 1}}
    wf["save"] = {"class_type": "SaveImage", "inputs": {"images": ["face", 0], "filename_prefix": "companion"}}
    return wf


REAR_VIEW = ("from behind", "rear view", "back view", "back to the camera", "seen from behind")


def is_rear_view(scene: str) -> bool:
    return any(k in scene.lower() for k in REAR_VIEW)


class FaceCheck:
    """Apparent age and resemblance of the largest face (InsightFace, CPU)."""

    def __init__(self, root: str, ref: str | None):
        from insightface.app import FaceAnalysis
        self.app = FaceAnalysis(name="buffalo_l", root=root, allowed_modules=["detection", "genderage", "recognition"],
                                providers=["CPUExecutionProvider"])
        self.app.prepare(ctx_id=-1, det_size=(640, 640))
        self.ref = self._face(ref).normed_embedding if ref else None

    def _face(self, path: str):
        import cv2
        faces = self.app.get(cv2.imread(path))
        return max(faces, key=lambda f: f.bbox[2] - f.bbox[0]) if faces else None

    def verdict(self, path: str, rear_view: bool) -> str | None:
        """Reason to reject the picture, or None when it is acceptable."""
        face = self._face(path)
        if face is None:
            return None if rear_view else "no face"
        if int(face.age) < MIN_APPARENT_AGE:
            return f"apparent age {int(face.age)}"
        if self.ref is not None:
            similarity = float((face.normed_embedding * self.ref).sum())
            minimum = MIN_RESEMBLANCE_TURNED if self._hard_to_measure(face, path) else MIN_RESEMBLANCE
            if similarity < minimum:
                return f"resemblance {similarity:.2f} < {minimum}"
        return None

    @staticmethod
    def _hard_to_measure(face, path: str) -> bool:
        """Turned (three-quarter, profile) or small faces."""
        import cv2
        left_eye, right_eye, nose = face.kps[0], face.kps[1], face.kps[2]
        eye_distance = max(1.0, abs(right_eye[0] - left_eye[0]))
        offset = abs(nose[0] - (left_eye[0] + right_eye[0]) / 2) / eye_distance
        width = cv2.imread(path).shape[1]
        return offset > TURNED_FACE_OFFSET or (face.bbox[2] - face.bbox[0]) / width < SMALL_FACE_RATIO


class Tagger:
    """Danbooru-style tags of a picture (JoyTag: trained on photos as well as drawings), on the CPU."""
    SIZE = 448
    MEAN = (0.48145466, 0.4578275, 0.40821073)
    STD = (0.26862954, 0.26130258, 0.27577711)

    def __init__(self, root: str):
        import onnxruntime
        self.session = onnxruntime.InferenceSession(os.path.join(root, "model.onnx"), providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        with open(os.path.join(root, "top_tags.txt"), encoding="utf-8") as f:
            self.tags = [line.strip().replace("_", " ") for line in f if line.strip()]

    def tag(self, path: str) -> list[str]:
        """Tags above the threshold, most confident first."""
        import numpy as np
        from PIL import Image
        image = Image.open(path).convert("RGB")
        # Padded to a white square, like JoyTag's training pictures.
        side = max(image.size)
        square = Image.new("RGB", (side, side), (255, 255, 255))
        square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        pixels = np.asarray(square.resize((self.SIZE, self.SIZE), Image.BICUBIC), dtype=np.float32) / 255.0
        pixels = (pixels - np.array(self.MEAN, dtype=np.float32)) / np.array(self.STD, dtype=np.float32)
        logits = self.session.run(None, {self.input: pixels.transpose(2, 0, 1)[None]})[0][0]
        scores = 1 / (1 + np.exp(-logits))
        ranked = sorted(((float(score), tag) for tag, score in zip(self.tags, scores) if score >= TAG_THRESHOLD), reverse=True)
        return [tag for _, tag in ranked]


def missing(tags: list[str], expect: list[list[str]]) -> list[list[str]]:
    """Expected groups with none of their tags in the picture."""
    found = set(tags)
    return [group for group in expect if not found.intersection(group)]


class Photo:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.comfy = Comfy(cfg)
        self.faces = None
        self.tagger = None
        self.lock = threading.Lock()

    def generate(self, scene: str, level: str, out: str, negative: str = "", loras: list | None = None,
                 expect: list | None = None) -> dict:
        with self.lock:
            self.comfy.ensure()
            if self.faces is None:
                self.faces = FaceCheck(self.cfg["insightfaceRoot"], self.cfg.get("faceRef"))
            if self.tagger is None and self.cfg.get("taggerDir"):
                self.tagger = Tagger(self.cfg["taggerDir"])
            # Passed the face checks but misses something asked: sent if no better one comes.
            fallback: tuple[str, list[str]] | None = None
            expect_retries = 0
            try:
                for attempt in range(MAX_ATTEMPTS):
                    path = self.comfy.run(build_workflow(self.cfg, scene, level, random.randint(1, 2**31), negative, loras))
                    reason = self.faces.verdict(path, is_rear_view(scene))
                    if reason:
                        os.remove(path)
                        print(f"[photo] rejected: {reason}", flush=True)
                        time.sleep(ATTEMPT_PAUSE_S)
                        continue
                    tags = self.tagger.tag(path) if self.tagger else []
                    forbidden = FORBIDDEN_TAGS.intersection(tags)
                    if forbidden:
                        os.remove(path)
                        print(f"[photo] rejected: tagged {', '.join(sorted(forbidden))}", flush=True)
                        time.sleep(ATTEMPT_PAUSE_S)
                        continue
                    lacking = missing(tags, expect or []) if self.tagger else []
                    if lacking and expect_retries < MAX_EXPECT_RETRIES and attempt + 1 < MAX_ATTEMPTS:
                        print(f"[photo] missing {lacking}, regenerating (tags: {', '.join(tags[:20])})", flush=True)
                        expect_retries += 1
                        if fallback:
                            os.remove(fallback[0])
                        fallback = (path, tags)
                        time.sleep(ATTEMPT_PAUSE_S)
                        continue
                    if fallback:
                        os.remove(fallback[0])
                        fallback = None
                    return self._send(path, out, tags, not lacking)
                if fallback:
                    return self._send(fallback[0], out, fallback[1], False)
                raise RuntimeError("no acceptable picture")
            finally:
                self.comfy.free()

    def _send(self, path: str, out: str, tags: list[str], matched: bool) -> dict:
        self._export(path, out)
        os.remove(path)
        print(f"[photo] sent (matched: {matched}, tags: {', '.join(tags[:20])})", flush=True)
        return {"tags": tags, "matched": matched}

    @staticmethod
    def _export(src: str, out: str) -> None:
        # Re-encode as JPEG like a phone photo; this also drops ComfyUI's embedded workflow metadata.
        from PIL import Image
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
            Image.open(src).convert("RGB").save(tmp.name, "JPEG", quality=85)
        shutil.move(tmp.name, out)


def make_handler(photo: Photo):
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
            if self.path != "/generate":
                return self._reply(404, {"error": "not found"})
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                level = req.get("level") or ("hard" if req.get("nsfw") else "normal")
                result = photo.generate(req["scene"], level, req["out"], req.get("negative") or "", req.get("loras") or [],
                                        req.get("expect") or [])
                self._reply(200, {"ok": True, **result})
            except Exception as err:
                self._reply(500, {"error": str(err)})

        def log_message(self, *_):
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--config", required=True, help="JSON photo settings (see profile.json `photo`)")
    args = parser.parse_args()
    cfg = json.loads(args.config)
    photo = Photo(cfg)
    # hub stops this service with SIGTERM: take ComfyUI down with it.
    signal.signal(signal.SIGTERM, lambda *_: (photo.comfy.stop(), os._exit(0)))
    try:
        HTTPServer(("127.0.0.1", args.port), make_handler(photo)).serve_forever()
    finally:
        photo.comfy.stop()


if __name__ == "__main__":
    main()
