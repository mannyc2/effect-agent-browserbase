"""Pinned, bench-only screenshot perception; one process owns one model mode.

Normal serve/test paths are offline. Run the explicit 'prepare' command to fetch
pinned assets into a caller-owned scratch directory. Parser and grounder use
separate environments: the legacy Florence captioner needs Transformers 4.49.0;
Holo2 uses 5.9.0. See perception-requirements.txt for the parser environment.

Detector decoding follows Microsoft's MIT icon_detect_v3 model card:
https://huggingface.co/microsoft/OmniParser-v2.0/tree/f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4
Holo preprocessing/prompt follows the Apache-2.0 H Company cookbook:
https://github.com/hcompai/hai-cookbook/tree/177fe305b2b0d67a591491d36981556101f40553
No browser, DOM, provider credential, or input execution is available here.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import csv
import fcntl
import gc
import hashlib
import importlib.metadata
import io
import json
import math
import os
from pathlib import Path
import platform
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

OMNI = ("microsoft/OmniParser-v2.0", "f55d0750e5b94db2125ef0b45b0fa4a85ddc59b4")
HOLO = ("Hcompany/Holo2-4B", "44b125965ebefea6c04958f972a0219cff36e90d")
PROCESSOR = ("microsoft/Florence-2-base", "5ca5edf5bd017b9919c05d08aebef5e4c7ac3bac")
CAPTION_CODE = ("microsoft/Florence-2-base-ft", "f6c1a25888ffc1d945ee8a1a77ac833c7303d46e")
PARSE_PREPROCESSING = "v3-top-left1280-conf005-nms045+tesseract-eng-psm11+florence64-caption20-v1"
GROUND_PREPROCESSING = "holo2-smart-resize32-max1048576-thinking-off-json1000-tokens32-v1"
OCR_DATA_SHA256 = "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2"
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_REQUEST_BYTES = 7 * 1024 * 1024
MAX_ELEMENTS = 256
MAX_ICONS = 64
FAILURES = {
    "MissingWeights", "RuntimeUnavailable", "GpuCapacity", "WrongMode", "Busy", "Timeout",
    "InvalidImage", "InvalidOutput", "IdentityMismatch", "LimitExceeded", "Unavailable",
}


class PerceptionFailure(Exception):
    def __init__(self, reason: str):
        if reason not in FAILURES:
            raise ValueError("Unknown failure category")
        self.reason = reason
        super().__init__(reason)

    def wire(self) -> dict[str, str]:
        return {"_tag": "PerceptionError", "reason": self.reason}


def fail(reason: str):
    raise PerceptionFailure(reason)


def version(name: str) -> str:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return "missing"


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("InvalidOutput")
        result[key] = value
    return result


def strict_json(data: str):
    try:
        return json.loads(data, object_pairs_hook=unique_object,
                          parse_constant=lambda _: fail("InvalidOutput"))
    except (ValueError, UnicodeError):
        fail("InvalidOutput")


def finite(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def observation(payload: dict) -> dict:
    return {key: payload[key] for key in ("sha256", "width", "height", "page", "at")}


def decode_image(payload: object, *, ground: bool = False):
    from PIL import Image

    fields = {"data", "mimeType", "sha256", "width", "height", "page", "at"}
    if ground:
        fields.add("what")
    if not isinstance(payload, dict) or set(payload) != fields:
        fail("InvalidImage")
    if payload["mimeType"] != "image/jpeg":
        fail("InvalidImage")
    if not isinstance(payload["sha256"], str) or len(payload["sha256"]) != 64 or any(
        char not in "0123456789abcdef" for char in payload["sha256"]
    ):
        fail("IdentityMismatch")
    if not isinstance(payload["page"], str) or not 1 <= len(payload["page"]) <= 200:
        fail("InvalidImage")
    if not finite(payload["at"]) or payload["at"] < 0:
        fail("InvalidImage")
    for key in ("width", "height"):
        if type(payload[key]) is not int or not 1 <= payload[key] <= 4096:
            fail("InvalidImage")
    if payload["width"] * payload["height"] > 4096 * 2160:
        fail("LimitExceeded")
    if ground and (not isinstance(payload["what"], str) or not payload["what"].strip()
                   or len(payload["what"]) > 512):
        fail("InvalidOutput")
    encoded = payload["data"]
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES + 2) // 3 * 4:
        fail("LimitExceeded")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        fail("InvalidImage")
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        fail("LimitExceeded")
    if hashlib.sha256(raw).hexdigest() != payload["sha256"]:
        fail("IdentityMismatch")
    # Pillow's default rejects truncated JPEGs. Verify and fully decode before inference.
    try:
        with Image.open(io.BytesIO(raw)) as candidate:
            if candidate.format != "JPEG" or candidate.size != (payload["width"], payload["height"]):
                fail("InvalidImage")
            candidate.verify()
        with Image.open(io.BytesIO(raw)) as candidate:
            candidate.load()
            image = candidate.convert("RGB")
    except (OSError, ValueError, Image.DecompressionBombError):
        fail("InvalidImage")
    return image, observation(payload)


def validate_box(box: object, width: int, height: int) -> dict:
    if not isinstance(box, dict) or set(box) != {"x0", "y0", "x1", "y1"}:
        fail("InvalidOutput")
    if not all(finite(value) for value in box.values()):
        fail("InvalidOutput")
    if not (0 <= box["x0"] < box["x1"] <= width and 0 <= box["y0"] < box["y1"] <= height):
        fail("InvalidOutput")
    return box


def normalized_point(content: str, width: int, height: int) -> tuple[float, float]:
    value = strict_json(content)
    if not isinstance(value, dict) or set(value) != {"x", "y"}:
        fail("InvalidOutput")
    if any(type(value[key]) is not int or not 0 <= value[key] <= 1000 for key in ("x", "y")):
        fail("InvalidOutput")
    x, y = value["x"] / 1000 * width, value["y"] / 1000 * height
    # An edge coordinate at width/height is outside the screenshot, not a point to clamp.
    if not (0 <= x < width and 0 <= y < height):
        fail("InvalidOutput")
    return x, y


def ordered_elements(elements: list[dict], width: int, height: int) -> list[dict]:
    if len(elements) > MAX_ELEMENTS:
        fail("LimitExceeded")
    for element in elements:
        validate_box(element["bbox"], width, height)
        if element["kind"] not in ("text", "icon") or element["interactable"] != (element["kind"] == "icon"):
            fail("InvalidOutput")
        if not isinstance(element["text"], str) or not 1 <= len(element["text"]) <= 256:
            fail("LimitExceeded")
    elements.sort(key=lambda e: (e["bbox"]["y0"], e["bbox"]["x0"], e["bbox"]["y1"],
                                  e["bbox"]["x1"], e["kind"], e["text"]))
    return [{"id": index + 1, **element} for index, element in enumerate(elements)]


def snapshot_path(root: Path, model: tuple[str, str]) -> Path:
    return root / "hub" / ("models--" + model[0].replace("/", "--")) / "snapshots" / model[1]


def prepare(root: Path, mode: str):
    from huggingface_hub import snapshot_download

    root.mkdir(parents=True, exist_ok=True)
    bundles = [(OMNI, ["icon_detect_v3/*", "icon_caption/*"]),
               (PROCESSOR, ["*.json", "*.py", "*.txt", "*.model", "LICENSE*"]),
               (CAPTION_CODE, ["*.json", "*.py", "*.txt", "*.model", "LICENSE*"])] if mode == "parse" else [
                   (HOLO, ["*.safetensors", "*.json", "*.jinja", "*.txt", "LICENSE*"])]
    for (name, revision), patterns in bundles:
        snapshot_download(name, revision=revision, cache_dir=root / "hub", allow_patterns=patterns)
    if mode == "parse":
        source = Path("/usr/share/tesseract-ocr/5/tessdata/eng.traineddata")
        if not source.is_file() or hashlib.sha256(source.read_bytes()).hexdigest() != OCR_DATA_SHA256:
            fail("MissingWeights")
        target = root / "tesseract" / "eng.traineddata"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    print(json.dumps({"prepared": mode, "root": str(root)}))


def gpu_memory() -> tuple[int, int] | None:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, check=True, timeout=5,
        )
        rows = result.stdout.strip().splitlines()
        if len(rows) != 1:
            return None
        total, free = (int(value.strip()) for value in rows[0].split(","))
        return total, free
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


class Runtime:
    def __init__(self, root: Path, mode: str, device: str, *, load: bool = True):
        self.root, self.mode, self.device = root, mode, device
        self.ready, self.reason = False, None
        self.required = 0 if device == "cpu" else (3072 if mode == "parse" else 16384)
        self.memory = gpu_memory() if device == "cuda" else None
        self.lock = threading.Lock()
        self.detector = self.caption = self.processor = self.grounder = None
        self.ocr_version = "unavailable"
        self.provenance = {
            "modelId": (OMNI if mode == "parse" else HOLO)[0],
            "revision": (OMNI if mode == "parse" else HOLO)[1],
            "preprocessing": PARSE_PREPROCESSING if mode == "parse" else GROUND_PREPROCESSING,
            "device": device,
            "runtime": {"python": platform.python_version(), "torch": version("torch"),
                        "transformers": version("transformers"), "ocr": self.ocr_version},
        }
        if mode == "parse":
            self.provenance.update(captionProcessorRevision=PROCESSOR[1], captionCodeRevision=CAPTION_CODE[1],
                                   ocrDataSha256=OCR_DATA_SHA256)
        try:
            self.preflight()
            if load:
                self.load()
                self.ready = True
            else:
                fail("RuntimeUnavailable")
        except PerceptionFailure as error:
            self.reason = error.reason
        except (ImportError, OSError, RuntimeError, ValueError, AttributeError):
            self.reason = "RuntimeUnavailable"
        if not self.ready:
            self.release_models()

    def release_models(self):
        self.detector = self.caption = self.processor = self.grounder = None
        gc.collect()
        torch = getattr(self, "torch", None)
        if torch is not None and self.device == "cuda" and torch.cuda.is_initialized():
            torch.cuda.empty_cache()

    def preflight(self):
        if self.mode == "ground" and self.device != "cuda":
            fail("GpuCapacity")
        if self.device == "cuda" and (self.memory is None or self.memory[1] < self.required):
            fail("GpuCapacity")
        expected_transformers = "4.49.0" if self.mode == "parse" else "5.9.0"
        if version("transformers") != expected_transformers or version("torch") != "2.11.0":
            fail("RuntimeUnavailable")
        if self.mode == "parse":
            required = [(OMNI, "icon_detect_v3/model.pt"), (OMNI, "icon_caption/model.safetensors"),
                        (PROCESSOR, "processing_florence2.py"), (CAPTION_CODE, "modeling_florence2.py")]
        else:
            required = [(HOLO, "model-00001-of-00002.safetensors"), (HOLO, "model-00002-of-00002.safetensors")]
        if any(not (snapshot_path(self.root, model) / file).is_file() for model, file in required):
            fail("MissingWeights")
        if self.mode == "parse":
            data = self.root / "tesseract" / "eng.traineddata"
            if not data.is_file() or hashlib.sha256(data.read_bytes()).hexdigest() != OCR_DATA_SHA256:
                fail("MissingWeights")
            if shutil.which("tesseract") is None:
                fail("RuntimeUnavailable")
            try:
                output = subprocess.run(["tesseract", "--version"], capture_output=True, text=True,
                                        check=True, timeout=5)
                self.ocr_version = output.stdout.splitlines()[0]
                if self.ocr_version != "tesseract 5.3.4":
                    fail("RuntimeUnavailable")
                self.provenance["runtime"]["ocr"] = self.ocr_version
            except (OSError, subprocess.SubprocessError, IndexError):
                fail("RuntimeUnavailable")

    def load(self):
        import torch

        torch.set_num_threads(2)
        if self.device == "cuda":
            # Reserve only this process's bounded share; never evict or move another workload.
            torch.cuda.set_per_process_memory_fraction(0.10 if self.mode == "parse" else 0.60)
        self.torch = torch
        if self.mode == "parse":
            from transformers import AutoModelForCausalLM, AutoProcessor

            self.detector = torch.jit.load(str(snapshot_path(self.root, OMNI) / "icon_detect_v3/model.pt"),
                                           map_location=self.device).eval()
            self.processor = AutoProcessor.from_pretrained(
                str(snapshot_path(self.root, PROCESSOR)), trust_remote_code=True,
                local_files_only=True, cache_dir=self.root / "hub", code_revision=PROCESSOR[1],
            )
            self.caption, info = AutoModelForCausalLM.from_pretrained(
                str(snapshot_path(self.root, OMNI) / "icon_caption"),
                trust_remote_code=True, local_files_only=True, cache_dir=self.root / "hub",
                code_revision=CAPTION_CODE[1], attn_implementation="eager",
                torch_dtype=torch.float16 if self.device == "cuda" else torch.float32,
                output_loading_info=True,
            )
            if any(info.get(key) for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs")):
                fail("RuntimeUnavailable")
            self.caption.to(self.device).eval()
        else:
            from transformers import AutoModelForImageTextToText, AutoProcessor

            self.processor = AutoProcessor.from_pretrained(str(snapshot_path(self.root, HOLO)), local_files_only=True)
            self.grounder, info = AutoModelForImageTextToText.from_pretrained(
                str(snapshot_path(self.root, HOLO)), local_files_only=True,
                dtype=torch.bfloat16, device_map={"": "cuda"}, output_loading_info=True,
                attn_implementation="sdpa",
            )
            if any(info.get(key) for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs")):
                fail("RuntimeUnavailable")
            self.grounder.eval()

    def status(self) -> dict:
        return {"mode": self.mode, "ready": self.ready, "reason": self.reason,
                "provenance": self.provenance, "requiredFreeMiB": self.required,
                "gpuFreeMiB": None if self.memory is None else self.memory[1]}

    def infer(self, mode: str, payload: object) -> dict:
        if mode != self.mode:
            fail("WrongMode")
        if not self.ready:
            fail(self.reason or "RuntimeUnavailable")
        if not self.lock.acquire(blocking=False):
            fail("Busy")
        try:
            image, identity = decode_image(payload, ground=mode == "ground")
            if mode == "parse":
                value = {"elements": self.parse(image)}
            else:
                x, y = self.ground(image, payload["what"])
                value = {"x": x, "y": y}
            return {"observation": identity, "provenance": self.provenance, **value}
        except PerceptionFailure:
            raise
        except self.torch.cuda.OutOfMemoryError:
            # The mode remains unavailable after an allocation failure; no hidden retry or fallback.
            self.ready, self.reason = False, "GpuCapacity" if self.device == "cuda" else "RuntimeUnavailable"
            self.release_models()
            fail(self.reason)
        except (OSError, RuntimeError, ValueError, TypeError, KeyError, IndexError):
            fail("InvalidOutput")
        finally:
            self.lock.release()

    def detect(self, image) -> list[dict]:
        import numpy as np
        from PIL import Image
        from torchvision.ops import nms

        torch = self.torch
        scale = min(1280 / image.width, 1280 / image.height)
        resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.BILINEAR)
        canvas = Image.new("RGB", (1280, 1280), (114, 114, 114))
        canvas.paste(resized, (0, 0))
        tensor = torch.from_numpy(np.array(canvas)).permute(2, 0, 1).float()[None].to(self.device) / 255
        with torch.inference_mode():
            heads = self.detector(tensor)
        if len(heads) != 6:
            fail("InvalidOutput")
        boxes, scores = [], []
        for index, stride in enumerate((8, 16, 32)):
            cls, ltrb = heads[2 * index].sigmoid()[0, 0], heads[2 * index + 1][0]
            grid = 1280 // stride
            if tuple(cls.shape) != (grid, grid) or tuple(ltrb.shape) != (4, grid, grid):
                fail("InvalidOutput")
            gy, gx = torch.meshgrid(torch.arange(grid, device=self.device, dtype=torch.float32),
                                    torch.arange(grid, device=self.device, dtype=torch.float32), indexing="ij")
            left, top, right, bottom = ltrb
            boxes.append(torch.stack(((gx + .5 - left) * stride, (gy + .5 - top) * stride,
                                      (gx + .5 + right) * stride, (gy + .5 + bottom) * stride), dim=-1).reshape(-1, 4))
            scores.append(cls.reshape(-1))
        boxes, scores = torch.cat(boxes), torch.cat(scores)
        if not torch.isfinite(boxes).all() or not torch.isfinite(scores).all():
            fail("InvalidOutput")
        keep = scores > .05
        boxes, scores = boxes[keep], scores[keep]
        keep = nms(boxes, scores, .45)
        boxes = boxes[keep] / scale
        boxes[:, 0::2] = boxes[:, 0::2].clamp(0, image.width)
        boxes[:, 1::2] = boxes[:, 1::2].clamp(0, image.height)
        result = [dict(zip(("x0", "y0", "x1", "y1"), row)) for row in boxes.cpu().tolist()]
        if len(result) > MAX_ICONS:
            fail("LimitExceeded")
        return [validate_box(box, image.width, image.height) for box in result]

    def ocr(self, image) -> list[dict]:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        try:
            completed = subprocess.run(
                ["tesseract", "stdin", "stdout", "--tessdata-dir", str(self.root / "tesseract"),
                 "-l", "eng", "--psm", "11", "-c", "tessedit_create_tsv=1"],
                input=buffer.getvalue(), capture_output=True, timeout=15, check=True,
                env={**os.environ, "OMP_THREAD_LIMIT": "2"},
            )
        except subprocess.TimeoutExpired:
            fail("Timeout")
        except (OSError, subprocess.CalledProcessError):
            fail("RuntimeUnavailable")
        if len(completed.stdout) > 256 * 1024:
            fail("LimitExceeded")
        lines = {}
        try:
            for row in csv.DictReader(io.StringIO(completed.stdout.decode("utf-8")), delimiter="\t"):
                if row["level"] != "5" or not row["text"].strip():
                    continue
                key = tuple(row[field] for field in ("page_num", "block_num", "par_num", "line_num"))
                x, y, w, h = (int(row[field]) for field in ("left", "top", "width", "height"))
                box = validate_box({"x0": x, "y0": y, "x1": x + w, "y1": y + h}, image.width, image.height)
                lines.setdefault(key, []).append((box, row["text"].strip()))
        except (UnicodeError, KeyError, ValueError, TypeError):
            fail("InvalidOutput")
        result = []
        for words in lines.values():
            words.sort(key=lambda word: word[0]["x0"])
            boxes = [word[0] for word in words]
            box = {"x0": min(b["x0"] for b in boxes), "y0": min(b["y0"] for b in boxes),
                   "x1": max(b["x1"] for b in boxes), "y1": max(b["y1"] for b in boxes)}
            result.append({"kind": "text", "bbox": box, "text": " ".join(word[1] for word in words),
                           "interactable": False})
        return ordered_elements(result, image.width, image.height)

    def caption_icon(self, image, box: dict) -> str:
        from PIL import Image

        crop = image.crop((math.floor(box["x0"]), math.floor(box["y0"]),
                           math.ceil(box["x1"]), math.ceil(box["y1"]))).resize((64, 64), Image.Resampling.BILINEAR)
        inputs = self.processor(images=[crop], text=["<CAPTION>"], return_tensors="pt", do_resize=False)
        inputs = inputs.to(device=self.device)
        pixels = inputs["pixel_values"].to(dtype=self.caption.dtype)
        with self.torch.inference_mode():
            generated = self.caption.generate(input_ids=inputs["input_ids"], pixel_values=pixels,
                                              max_new_tokens=20, num_beams=1, do_sample=False,
                                              early_stopping=False, forced_eos_token_id=None)
        # Florence delegates to its BART language model; the outer config has a different EOS.
        # Disabling forced EOS prevents a token-limit truncation from looking like completion.
        self.complete(generated[0], self.caption.language_model.generation_config.eos_token_id)
        text = self.processor.batch_decode(generated, skip_special_tokens=True)[0].strip()
        if not 1 <= len(text) <= 256:
            fail("InvalidOutput")
        return text

    @staticmethod
    def complete(tokens, eos):
        valid = eos if isinstance(eos, list) else [eos]
        if len(tokens) == 0 or int(tokens[-1]) not in valid:
            fail("InvalidOutput")

    def parse(self, image) -> list[dict]:
        text = self.ocr(image)
        boxes = self.detect(image)
        elements = [{key: value for key, value in element.items() if key != "id"} for element in text]
        for box in boxes:
            # OCR labels are visible pixels, never DOM text. Icons without readable text use Florence.
            labels = []
            for element in text:
                word = element["bbox"]
                area = (word["x1"] - word["x0"]) * (word["y1"] - word["y0"])
                intersection = max(0, min(word["x1"], box["x1"]) - max(word["x0"], box["x0"])) * max(
                    0, min(word["y1"], box["y1"]) - max(word["y0"], box["y0"]))
                if intersection / area >= .8:
                    labels.append(element["text"])
            label = " ".join(labels) if labels else self.caption_icon(image, box)
            elements.append({"kind": "icon", "bbox": box, "text": label, "interactable": True})
        return ordered_elements(elements, image.width, image.height)

    def ground(self, image, what: str) -> tuple[float, float]:
        from PIL import Image
        from transformers.models.qwen2_vl.image_processing_qwen2_vl import smart_resize

        processor = self.processor.image_processor
        height, width = smart_resize(image.height, image.width,
                                    factor=processor.patch_size * processor.merge_size,
                                    min_pixels=64 * 32 * 32, max_pixels=1024 * 1024)
        prepared = image.resize((width, height), Image.Resampling.LANCZOS)
        schema = {"type": "object", "properties": {"x": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "Coordinate normalized between 0 and 1000"},
                   "y": {"type": "integer", "minimum": 0, "maximum": 1000, "description": "Coordinate normalized between 0 and 1000"}}, "required": ["x", "y"],
                   "additionalProperties": False}
        prompt = ("Localize an element on the GUI image according to the provided target and output a click position. "
                  "You must output a valid JSON following the format: " + json.dumps(schema) +
                  "\nYour target is:\n" + what)
        messages = [{"role": "user", "content": [{"type": "image", "image": prepared},
                                                 {"type": "text", "text": prompt}]}]
        rendered = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, thinking=False)
        inputs = self.processor(text=[rendered], images=[prepared], padding=True, return_tensors="pt").to("cuda")
        with self.torch.inference_mode():
            generated = self.grounder.generate(**inputs, max_new_tokens=32, do_sample=False)
        continuation = generated[0][inputs["input_ids"].shape[-1]:]
        self.complete(continuation, self.grounder.generation_config.eos_token_id)
        content = self.processor.decode(continuation, skip_special_tokens=True).strip()
        return normalized_point(content, image.width, image.height)


def serve(runtime: Runtime, port: int):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def setup(self):
            super().setup()
            self.connection.settimeout(10)

        def reply(self, status: int, body: dict):
            encoded = json.dumps(body, allow_nan=False, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                return

        def do_GET(self):
            if self.path != "/status":
                self.reply(404, PerceptionFailure("Unavailable").wire())
                return
            self.reply(200, runtime.status())

        def do_POST(self):
            try:
                if self.path not in ("/parse", "/ground") or self.headers.get("Transfer-Encoding") is not None:
                    fail("Unavailable")
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= MAX_REQUEST_BYTES:
                    fail("LimitExceeded")
                raw = self.rfile.read(length)
                if len(raw) != length:
                    fail("InvalidImage")
                payload = strict_json(raw.decode("utf-8"))
                self.reply(200, runtime.infer(self.path[1:], payload))
            except PerceptionFailure as error:
                self.reply(503 if error.reason in ("MissingWeights", "RuntimeUnavailable", "GpuCapacity", "Busy") else 400,
                           error.wire())
            except (ValueError, UnicodeError, TimeoutError):
                self.reply(400, PerceptionFailure("InvalidImage").wire())

    # A single serving thread provides a bounded queue without concurrent model copies or inference.
    class Server(HTTPServer):
        request_queue_size = 16

    with Server(("127.0.0.1", port), Handler) as server:
        print(json.dumps({"listening": server.server_port, "pid": os.getpid(), "status": runtime.status()}), flush=True)
        server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "serve"))
    parser.add_argument("--models-root", type=Path, required=True)
    parser.add_argument("--mode", choices=("parse", "ground"), required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args()
    root = args.models_root.resolve()
    if args.command == "prepare":
        prepare(root, args.mode)
        return
    if not 0 <= args.port <= 65535:
        parser.error("port must be in 0..65535")
    root.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_MODULES_CACHE"] = str(root / "modules")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    # One root is shared across modes and workers; a second owner fails before loading any model.
    with (root / "owner.lock").open("a+") as owner:
        try:
            fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps(PerceptionFailure("Busy").wire()))
            raise SystemExit(2)
        owner.seek(0)
        owner.truncate()
        owner.write(str(os.getpid()) + "\n")
        owner.flush()
        runtime = Runtime(root, args.mode, args.device)
        if args.preflight_only:
            print(json.dumps(runtime.status()))
            raise SystemExit(0 if runtime.ready else 2)
        serve(runtime, args.port)


if __name__ == "__main__":
    main()
