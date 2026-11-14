"""Run an action with a matched QQ build and a pinned account."""
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep, time

from hook.native_session import NativeSession
from build_profile import require_build_profile
from win_account import AccountDetector
from win_process import locate_qq


class PendingAction:
    def __init__(self, root, command, profile, module, account):
        self.id = command["id"]
        self.type = command["type"]
        self.submitted = False
        self.dispatch_deadline = monotonic() + 5
        self.deadline = monotonic() + 30
        self.directory = TemporaryDirectory(prefix="qq-action-", dir=root / "build")
        self.report = Path(self.directory.name) / "result.json"
        params = command["params"]
        if self.type == "send-message":
            segments_path = self.report.with_name("segments.json")
            segments_path.write_text(json.dumps(params["segments"]), encoding="utf-8")
            params = {key: value for key, value in params.items() if key != "segments"}
            params["segmentsPath"] = str(segments_path)
        if self.type == "send-forward-message" and "nodes" in params:
            params = dict(params)
            nodes_path = self.report.with_name("nodes.json")
            nodes_path.write_text(json.dumps(params.pop("nodes")), encoding="utf-8")
            params["nodesPath"] = str(nodes_path)
            expires_after = 27
        elif self.type in {"get-essence-list", "get-group-notice", "delete-group-notice", "set-group-settings"}:
            expires_after = 27
        else:
            expires_after = 15
        self.request = json.dumps({
            **params,
            "type": self.type,
            "capability": profile["actions"]["sendGroupText"],
            "wrapperPath": str(module),
            "reportPath": str(self.report),
            "selfId": account,
            "expires": int((time() + expires_after) * 1000),
        }).encode("ascii")

    def poll(self, session, detector, account):
        if self.submitted:
            try:
                return json.loads(self.report.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError):
                if monotonic() >= self.deadline:
                    return {"status": "unknown", "error": "QQ did not confirm the action"}
            return None
        if monotonic() >= self.dispatch_deadline:
            return {"status": "failed", "error": "QQ action queue is not ready"}
        if detector.current() != account:
            return {"status": "failed", "error": "QQ account changed"}
        if len(self.request) >= 8192:
            return {"status": "failed", "error": "Native action metadata exceeds 8191 bytes"}
        # A failed remote call may have already queued the action.
        self.submitted = True
        try:
            status = session.submit_action(self.request)
        except (OSError, RuntimeError):
            return {"status": "unknown", "error": "QQ did not confirm that the action was queued"}
        if status == 0:
            return None
        self.submitted = False
        if status == 20:
            return None
        return {"status": "failed", "error": f"QQ action queue rejected the request ({status})"}

    def close(self):
        self.directory.cleanup()


def run_action(root, action, parameters, *, pid, pipe):
    pid, _, module, _ = locate_qq(pid=pid)
    profile = require_build_profile(root, module)
    capability = profile.get("actions", {}).get(action)
    if not capability:
        raise RuntimeError(f"QQ {profile.get('build', 'build')} does not support {action}")
    hook = profile["receive"]["probe"]
    detector = AccountDetector(pid)
    account = detector.current()
    if account is None:
        raise RuntimeError("Unable to identify the logged-in QQ account")

    build = root / "build"
    with TemporaryDirectory(prefix="qq-action-", dir=build) as directory:
        report = Path(directory) / "result.json"
        request = json.dumps({
            **parameters,
            "capability": capability,
            "wrapperPath": str(module),
            "reportPath": str(report),
            "selfId": account,
            "expires": int((time() + 35) * 1000),
        }).encode("ascii")
        with NativeSession(pid, build / capability["module"], int(hook["callRva"], 16),
                           bytes.fromhex(hook["instruction"]), pipe, action_request=request) as session:
            deadline = monotonic() + 48
            while session.is_running() and monotonic() < deadline:
                try:
                    return json.loads(report.read_text(encoding="utf-8"))
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                if detector.current() != account:
                    raise RuntimeError("QQ account changed. Check the result before trying again.")
                sleep(0.3)
            raise RuntimeError("No action confirmation. Check the result before trying again.")
