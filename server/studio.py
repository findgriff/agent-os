"""Image Studio — Fal.ai image generation for AGENT OS.

A thin, provider-agnostic wrapper over Fal's synchronous run endpoint
(https://fal.run/{model}). Everything soft-fails: a missing key or a Fal
outage returns an {error} dict rather than raising, so the handler can log
the failure and hand a clean message back to the studio UI.

Key resolution: config['api_key'] → FAL_KEY env → FAL_KEY_ID:FAL_KEY_SECRET.
Fal keys are the pair "key_id:key_secret"; we accept either form.
"""
from __future__ import annotations
import json
import logging
import os
import random
import time
import urllib.request
from pathlib import Path

from server import inference

log = logging.getLogger("agentos.studio")

# ── Model catalogue ─────────────────────────────────────────────────────
# ui id → (fal endpoint, capabilities). `steps` is the sane default; `max_steps`
# caps the UI slider expectation; flags gate optional payload params; `cost` is
# an approximate USD price per image (drives the estimate, not billing truth).
MODELS = {
    "flux_schnell": {
        "endpoint": "fal-ai/flux/schnell", "label": "FLUX Schnell",
        "blurb": "Fastest & cheapest — great for iterating.",
        "steps": 4, "max_steps": 12, "guidance": False, "negative": False,
        "cost": 0.003,
    },
    "flux_dev": {
        "endpoint": "fal-ai/flux/dev", "label": "FLUX Dev",
        "blurb": "Balanced quality and speed.",
        "steps": 28, "max_steps": 50, "guidance": True, "negative": False,
        "cost": 0.025,
    },
    "flux_pro": {
        "endpoint": "fal-ai/flux-pro", "label": "FLUX Pro",
        "blurb": "Highest fidelity FLUX generation.",
        "steps": 40, "max_steps": 50, "guidance": True, "negative": False,
        "cost": 0.05,
    },
    "flux_realism": {
        "endpoint": "fal-ai/flux-realism", "label": "FLUX Realism",
        "blurb": "Photorealistic people and scenes.",
        "steps": 32, "max_steps": 50, "guidance": True, "negative": False,
        "cost": 0.04,
    },
    "flux2_pro": {
        "endpoint": "fal-ai/flux-pro/v1.1", "label": "FLUX 2 Pro",
        "blurb": "Latest-gen FLUX Pro — sharpest detail.",
        "steps": 40, "max_steps": 50, "guidance": True, "negative": False,
        "cost": 0.06,
    },
    "sdxl": {
        "endpoint": "fal-ai/fast-sdxl", "label": "SDXL",
        "blurb": "Legacy Stable Diffusion XL — supports negatives.",
        "steps": 25, "max_steps": 50, "guidance": True, "negative": True,
        "cost": 0.01,
    },
    "comfyui": {
        "endpoint": "comfyui", "label": "ComfyUI (Mac)",
        "blurb": "Local generation on your Mac via ComfyUI — no filters.",
        "steps": 20, "max_steps": 50, "guidance": True, "negative": True,
        "cost": 0,
    },
}
DEFAULT_MODEL = "flux_schnell"

# aspect ratio → pixel dimensions (kept ≤ ~1.3MP so Fal stays fast).
ASPECT_DIMS = {
    "1:1": (1024, 1024), "16:9": (1344, 768), "9:16": (768, 1344),
    "4:3": (1152, 896), "3:4": (896, 1152), "3:2": (1216, 832),
    "2:3": (832, 1216),
}


def _fal_key(config: dict | None = None) -> str:
    """Resolve a Fal key. Priority: connection config → FAL_KEY (env/secret/
    vault) → FAL_KEY_ID:FAL_KEY_SECRET pair (env/secret/vault). The vault
    lookup reads the same files inference._key() scans (e.g. ~/.hermes/.env),
    so the service resolves keys without extra systemd config."""
    config = config or {}
    key = (config.get("api_key") or "").strip()
    if key:
        return key
    # Prefer the explicit id:secret pair (Fal's key format). We resolve each
    # part precisely — note a loose "FAL_KEY" vault scan would prefix-match the
    # "FAL_KEY_ID=" line and return only the id, so we DON'T do that here.
    kid = inference._key("FAL_KEY_ID", "/etc/agent-os/fal-key-id")
    secret = inference._key("FAL_KEY_SECRET", "/etc/agent-os/fal-key-secret")
    if kid and secret:
        return f"{kid}:{secret}"
    # A single-token FAL_KEY only from the process env or a dedicated secret
    # file (never the shared vault scan, which is prefix-imprecise).
    env_key = os.environ.get("FAL_KEY", "").strip()
    if env_key:
        return env_key
    try:
        with open("/etc/agent-os/fal-key") as f:
            return f.read().strip()
    except OSError:
        return ""


def list_models() -> list[dict]:
    """Model catalogue for the studio's model picker."""
    return [{"id": k, "label": v["label"], "blurb": v["blurb"],
             "steps": v["steps"], "max_steps": v["max_steps"],
             "guidance": v["guidance"], "negative": v["negative"],
             "cost": v["cost"]} for k, v in MODELS.items()]


def estimate_cost(model: str, steps: int, num_images: int) -> float:
    """Approximate USD cost. Scales gently with step count above the default."""
    spec = MODELS.get(model, MODELS[DEFAULT_MODEL])
    base = spec["cost"]
    step_factor = max(0.5, (steps or spec["steps"]) / max(1, spec["steps"]))
    return round(base * step_factor * max(1, num_images), 4)


def _dims(aspect_ratio: str, width, height) -> tuple[int, int]:
    if width and height:
        try:
            return int(width), int(height)
        except (TypeError, ValueError):
            pass
    return ASPECT_DIMS.get(aspect_ratio or "1:1", (1024, 1024))


def _payload(spec: dict, config: dict) -> dict:
    w, h = _dims(config.get("aspect_ratio"), config.get("width"), config.get("height"))
    seed = config.get("seed")
    num = max(1, min(4, int(config.get("num_images") or 1)))
    body: dict = {
        "prompt": config.get("prompt", ""),
        "image_size": {"width": w, "height": h},
        "num_images": num,
        "enable_safety_checker": bool(config.get("safe_mode", True)),
    }
    steps = config.get("steps")
    if steps:
        body["num_inference_steps"] = int(steps)
    if seed not in (None, "", "random"):
        try:
            body["seed"] = int(seed)
        except (TypeError, ValueError):
            pass
    if spec["guidance"] and config.get("guidance") is not None:
        body["guidance_scale"] = float(config["guidance"])
    if spec["negative"] and (config.get("negative_prompt") or "").strip():
        body["negative_prompt"] = config["negative_prompt"].strip()
    return body


def generate_image(config: dict, dest_dir: str | None = None,
                   session_id: str | None = None) -> dict:
    """Generate images via Fal or local ComfyUI."""
    model = config.get("model") or DEFAULT_MODEL
    spec = MODELS.get(model)
    if not spec:
        return {"error": f"unknown model '{model}'"}

    # Route to ComfyUI when that model is selected
    if model == "comfyui":
        return _generate_comfyui(config)

    key = _fal_key(config)
    if not key:
        return {"error": "no Fal.ai API key configured"}
    if not (config.get("prompt") or "").strip():
        return {"error": "prompt is required"}

    body = json.dumps(_payload(spec, config)).encode()
    req = urllib.request.Request(
        f"https://fal.run/{spec['endpoint']}", data=body, method="POST",
        headers={"Authorization": f"Key {key}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300] if hasattr(e, "read") else str(e)
        log.error("fal HTTPError %s: %s", e.code, detail)
        return {"error": f"Fal error {e.code}: {detail}"}
    except Exception as e:
        log.error("fal request failed: %s", e)
        return {"error": str(e)}

    raw_seed = data.get("seed")
    out = []
    for i, img in enumerate(data.get("images") or []):
        url = img.get("url")
        if not url:
            continue
        seed = img.get("seed", raw_seed)
        entry = {"url": url, "seed": seed, "model": model,
                 "width": img.get("width"), "height": img.get("height")}
        if dest_dir:
            local = _persist(url, dest_dir, session_id or "adhoc", seed, i)
            if local:
                entry["remote_url"] = url
                entry["url"] = local
        out.append(entry)
    if not out:
        return {"error": "Fal returned no images"}
    steps = int(config.get("steps") or spec["steps"])
    return {"images": out, "model": model,
            "cost": estimate_cost(model, steps, len(out))}


def _persist(url: str, dest_dir: str, session_id: str, seed, idx: int) -> str | None:
    """Download `url` into dest_dir/generated/<session>/ and return the
    site-relative served path (e.g. /generated/<session>/<ts>_<seed>.png)."""
    safe_session = "".join(c for c in str(session_id) if c.isalnum() or c in "-_") or "adhoc"
    folder = Path(dest_dir) / "generated" / safe_session
    try:
        folder.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        seed_part = seed if seed not in (None, "") else f"n{idx}"
        fname = f"{stamp}_{seed_part}.png"
        with urllib.request.urlopen(url, timeout=60) as r:
            (folder / fname).write_bytes(r.read())
        return f"/generated/{safe_session}/{fname}"
    except Exception as e:
        log.warning("could not persist image: %s", e)
        return None


# ── ComfyUI bridge ──────────────────────────────────────────────────────
# Sends prompts to a local ComfyUI instance running on the user's Mac.
# Set COMFYUI_HOST env var to the Mac's LAN IP, e.g. 192.168.1.100:8188

_COMFY_HOST = os.environ.get("COMFYUI_HOST", "127.0.0.1:8188")

def _comfyui_workflow(prompt: str, negative: str, seed: int, steps: int,
                       guidance: float, width: int, height: int) -> dict:
    """Build a txt2img workflow JSON for ComfyUI's /prompt endpoint."""
    # ComfyUI uses sequential node IDs — we define a minimal txt2img graph
    sid = seed if seed else random.randint(0, 2**32 - 1)
    return {
        "3": {  # KSampler
            "class_type": "KSampler",
            "inputs": {
                "seed": sid,
                "steps": steps,
                "cfg": guidance,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            }
        },
        "4": { "class_type": "CheckpointLoaderSimple",
               "inputs": {"ckpt_name": "sd_xl_base_1.0.safetensors"} },
        "5": { "class_type": "EmptyLatentImage",
               "inputs": {"width": width, "height": height, "batch_size": 1} },
        "6": { "class_type": "CLIPTextEncode",
               "inputs": {"text": prompt, "clip": ["4", 1]} },
        "7": { "class_type": "CLIPTextEncode",
               "inputs": {"text": negative or "", "clip": ["4", 1]} },
        "8": { "class_type": "VAEDecode",
               "inputs": {"samples": ["3", 0], "vae": ["4", 2]} },
        "9": { "class_type": "SaveImage",
               "inputs": {"filename_prefix": "agentos_", "images": ["8", 0]} },
    }


def _generate_comfyui(config: dict) -> dict:
    """Generate via a local ComfyUI. Returns same shape as Fal path."""
    prompt = (config.get("prompt") or "").strip()
    if not prompt:
        return {"error": "prompt is required"}
    seed = (config.get("seed") or random.randint(0, 2**32 - 1))
    try:
        seed = int(seed)
    except (TypeError, ValueError):
        seed = random.randint(0, 2**32 - 1)
    steps = int(config.get("steps") or 20)
    guidance = float(config.get("guidance") or 7.0)
    w, h = (int(config.get("width") or 1024), int(config.get("height") or 1024))
    negative = (config.get("negative_prompt") or "").strip()

    workflow = _comfyui_workflow(prompt, negative, seed, steps, guidance, w, h)
    body = json.dumps({"prompt": workflow}).encode()
    host = os.environ.get("COMFYUI_HOST", "127.0.0.1:8188")

    try:
        # Queue the prompt
        req = urllib.request.Request(
            f"http://{host}/prompt", data=body, method="POST",
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as r:
            result = json.loads(r.read())
        pid = result.get("prompt_id")
        if not pid:
            return {"error": "ComfyUI did not return a prompt_id"}

        # Poll for completion
        for _ in range(120):  # up to 2 min
            time.sleep(1)
            try:
                with urllib.request.urlopen(f"http://{host}/history/{pid}", timeout=10) as hr:
                    history = json.loads(hr.read())
                if pid in history:
                    outputs = history[pid].get("outputs", {})
                    # Find the SaveImage node output (node 9)
                    for node_id, node_out in outputs.items():
                        for img in node_out.get("images", []):
                            img_url = f"http://{host}/view?filename={img['filename']}&subfolder={img.get('subfolder', '')}&type={img.get('type', 'output')}"
                            return {
                                "images": [{
                                    "url": img_url,
                                    "seed": seed,
                                    "model": "comfyui",
                                    "width": img.get("width", w),
                                    "height": img.get("height", h),
                                }],
                                "model": "comfyui",
                                "cost": 0,
                            }
                    return {"error": "ComfyUI returned no images in the output"}
            except urllib.error.HTTPError:
                continue  # not ready yet
        return {"error": "ComfyUI generation timed out"}
    except Exception as e:
        log.error("comfyui request failed: %s", e)
        return {"error": f"ComfyUI error: {e}"}
