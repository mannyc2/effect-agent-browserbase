"""Free boundary tests. No model weights are loaded and no download is performed."""
import base64
import fcntl
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from contextlib import nullcontext
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

from PIL import Image

sys.dont_write_bytecode = True

SOURCE = Path(__file__).resolve().parents[1] / "perception.py"
SPEC = importlib.util.spec_from_file_location("perception", SOURCE)
perception = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(perception)


class PerceptionTests(unittest.TestCase):
    def fixture(self):
        buffer = io.BytesIO()
        Image.new("RGB", (80, 40), "white").save(buffer, format="JPEG")
        raw = buffer.getvalue()
        return {"data": base64.b64encode(raw).decode(), "mimeType": "image/jpeg",
                "sha256": hashlib.sha256(raw).hexdigest(), "width": 80, "height": 40,
                "page": "fixture", "at": 10.5}

    def assert_reason(self, reason, fn):
        with self.assertRaises(perception.PerceptionFailure) as result:
            fn()
        self.assertEqual(result.exception.reason, reason)

    def test_jpeg_identity_dimensions_and_complete_decode(self):
        payload = self.fixture()
        image, identity = perception.decode_image(payload)
        self.assertEqual(image.size, (80, 40))
        self.assertEqual(identity, {key: payload[key] for key in ("sha256", "width", "height", "page", "at")})
        self.assert_reason("IdentityMismatch", lambda: perception.decode_image({**payload, "sha256": "0" * 64}))
        self.assert_reason("InvalidImage", lambda: perception.decode_image({**payload, "width": 79}))
        self.assert_reason("InvalidImage", lambda: perception.decode_image({**payload, "at": float("nan")}))
        self.assert_reason("InvalidImage", lambda: perception.decode_image({**payload, "extra": "ignored?"}))
        truncated = base64.b64decode(payload["data"])[:-30]
        broken = {**payload, "data": base64.b64encode(truncated).decode(),
                  "sha256": hashlib.sha256(truncated).hexdigest()}
        self.assert_reason("InvalidImage", lambda: perception.decode_image(broken))
        png = io.BytesIO()
        Image.new("RGB", (80, 40), "white").save(png, format="PNG")
        wrong_type = {**payload, "data": base64.b64encode(png.getvalue()).decode(),
                      "sha256": hashlib.sha256(png.getvalue()).hexdigest()}
        self.assert_reason("InvalidImage", lambda: perception.decode_image(wrong_type))

    def test_normalized_coordinates_map_exactly_and_reject_partial_guesses(self):
        self.assertEqual(perception.normalized_point('{"x":500,"y":250}', 1280, 720), (640, 180))
        self.assertEqual(perception.normalized_point('{"x":0,"y":0}', 1280, 720), (0, 0))
        for value in [
            '{"x":1000,"y":250}', '{"x":-1,"y":2}', '{"x":1.5,"y":2}',
            '{"x":true,"y":2}', '{"x":1,"y":NaN}', '{"x":1,"y":2,"extra":3}',
            '{"x":1,"x":2,"y":2}', '{"x":1}', 'Click(1,2)', '```json\n{"x":1,"y":2}\n```',
        ]:
            with self.subTest(value=value):
                self.assert_reason("InvalidOutput", lambda: perception.normalized_point(value, 1280, 720))

    def test_ordered_ids_are_stable_and_all_boxes_stay_in_the_source_image(self):
        first = {"kind": "icon", "bbox": {"x0": 5, "y0": 10, "x1": 20, "y1": 20},
                 "text": "Submit", "interactable": True}
        second = {"kind": "text", "bbox": {"x0": 1, "y0": 1, "x1": 10, "y1": 8},
                  "text": "Title", "interactable": False}
        ordered = perception.ordered_elements([first, second], 80, 40)
        self.assertEqual([element["id"] for element in ordered], [1, 2])
        self.assertEqual([element["text"] for element in ordered], ["Title", "Submit"])
        self.assertEqual(ordered, perception.ordered_elements([second, first], 80, 40))
        self.assert_reason("InvalidOutput", lambda: perception.ordered_elements(
            [{**first, "bbox": {**first["bbox"], "x1": 81}}], 80, 40))
        self.assert_reason("LimitExceeded", lambda: perception.ordered_elements([first] * 257, 80, 40))

    def test_caption_completion_uses_the_actual_inner_generator(self):
        class Pixels:
            def to(self, **_):
                return self

        runtime = perception.Runtime.__new__(perception.Runtime)
        runtime.device = "cpu"
        runtime.torch = SimpleNamespace(inference_mode=nullcontext)
        runtime.processor = MagicMock()
        runtime.processor.return_value.to.return_value = {"input_ids": "ids", "pixel_values": Pixels()}
        runtime.processor.batch_decode.return_value = ["Markets"]
        runtime.caption = SimpleNamespace(
            dtype="float32", generation_config=SimpleNamespace(eos_token_id=1),
            language_model=SimpleNamespace(generation_config=SimpleNamespace(eos_token_id=2)),
            generate=MagicMock(return_value=[[2, 0, 55, 2]]),
        )
        image = Image.new("RGB", (80, 40), "white")
        box = {"x0": 0, "y0": 0, "x1": 20, "y1": 20}
        self.assertEqual(runtime.caption_icon(image, box), "Markets")
        self.assertIsNone(runtime.caption.generate.call_args.kwargs["forced_eos_token_id"])
        runtime.caption.generate.return_value = [[2, 0, 55, 19]]
        self.assert_reason("InvalidOutput", lambda: runtime.caption_icon(image, box))

    def test_failed_load_releases_partial_model_ownership(self):
        def failed_load(runtime):
            runtime.detector = object()
            runtime.caption = object()
            raise RuntimeError("loading failed")
        with tempfile.TemporaryDirectory(prefix="effect-perception-test-") as root:
            with patch.object(perception.Runtime, "preflight"), patch.object(perception.Runtime, "load", failed_load):
                runtime = perception.Runtime(Path(root), "parse", "cpu")
            self.assertFalse(runtime.ready)
            self.assertEqual(runtime.reason, "RuntimeUnavailable")
            self.assertIsNone(runtime.detector)
            self.assertIsNone(runtime.caption)

    def test_gpu_preflight_fails_before_import_or_model_loading(self):
        with tempfile.TemporaryDirectory(prefix="effect-perception-test-") as root:
            with patch.object(perception, "gpu_memory", return_value=(24564, 3478)), patch.object(
                perception.Runtime, "load", side_effect=AssertionError("must not load")
            ):
                runtime = perception.Runtime(Path(root), "ground", "cuda")
            self.assertFalse(runtime.ready)
            self.assertEqual(runtime.reason, "GpuCapacity")
            self.assertEqual(runtime.status()["gpuFreeMiB"], 3478)

    def test_one_scratch_root_has_one_model_owner(self):
        with tempfile.TemporaryDirectory(prefix="effect-perception-test-") as root:
            with (Path(root) / "owner.lock").open("w") as owner:
                fcntl.flock(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(
                    [sys.executable, str(SOURCE), "serve", "--models-root", root, "--mode", "parse",
                     "--device", "cpu", "--preflight-only"], capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout), {"_tag": "PerceptionError", "reason": "Busy"})


if __name__ == "__main__":
    unittest.main()
