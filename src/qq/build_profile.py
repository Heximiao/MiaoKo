"""Resolve the compatibility profile for the module loaded in a QQ process."""
import json
import subprocess


def inspect_loaded_module(root, module):
    result = subprocess.run([
        root / ".conda" / "node.exe", root / "src" / "qq" / "inspect-build.mjs",
        "--loaded-module", module,
    ], capture_output=True, encoding="utf-8")
    if not result.stdout:
        raise RuntimeError(result.stderr.strip() or "Unable to identify the loaded QQ build")
    return json.loads(result.stdout)


def require_build_profile(root, module):
    profile = inspect_loaded_module(root, module)
    if profile["status"] != "known-build":
        raise RuntimeError(
            f"QQ {profile['build']}: {profile['status']} (SHA-256 {profile['sha256']}). "
            "Validate this build before attaching."
        )
    return profile
