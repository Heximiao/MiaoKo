"""Start a receive session for a single running QQ process."""
import argparse
import ctypes as c
import json
import msvcrt
import os
from collections import deque
from pathlib import Path
import sys
from time import monotonic, sleep, time

project = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(project / "src" / "qq"))
from hook.native_session import NativeSession
from actions.runtime import PendingAction
from build_profile import require_build_profile
from win_account import AccountDetector
from win_process import api, boolean, dword, find_qq, handle, locate_qq, pointer


peek_pipe = api("PeekNamedPipe", boolean, handle, pointer, dword, pointer, c.POINTER(dword), pointer)
action_types = {
    "send-message", "recall-message", "get-message", "get-image", "resolve-reply", "resolve-mention",
    "get-group-member", "get-group-member-list", "get-user-profile",
    "get-group-list", "get-group-info", "get-friend-list",
    "send-poke", "recall-poke", "set-emoji-like", "get-emoji-likes", "resolve-reaction",
    "get-message-history", "send-profile-like",
    "get-forward-message", "send-forward-message",
    "get-group-root-files", "get-group-file-url", "create-group-file-folder",
    "get-group-album-list", "upload-group-album",
    "set-group-ban", "set-group-whole-ban", "set-group-kick",
    "get-group-detail-info", "set-group-leave", "set-group-admin", "set-group-name", "set-group-card",
    "get-group-shut-list", "get-group-ignored-notifies", "set-group-settings",
    "get-group-notice", "delete-group-notice", "get-essence-list", "change-group-essence",
    "group-todo", "group-sign",
    "set-group-special-title",
    "handle-group-request", "handle-friend-request",
    "resolve-media-url",
}


class ParentCommands:
    def __init__(self, fd):
        self.fd = fd
        msvcrt.setmode(fd, os.O_BINARY)
        self.pipe = msvcrt.get_osfhandle(fd)
        self.partial = b""
        self.lines = deque()

    def poll(self):
        if not self.lines:
            available = dword()
            if not peek_pipe(self.pipe, None, 0, None, c.byref(available), None):
                error = c.get_last_error()
                if error in (109, 232, 233):
                    return "stop"
                raise c.WinError(error)
            if not available.value:
                return None
            data = os.read(self.fd, min(available.value, 65536))
            if not data:
                return "stop"
            lines = (self.partial + data).split(b"\n")
            self.partial = lines.pop()
            self.lines.extend(lines)
            if not self.lines:
                return None
        line = self.lines.popleft()
        if line.strip() == b"?":
            return "check"
        command = json.loads(line)
        return command if isinstance(command, dict) and command.get("type") in action_types else "stop"


def report(event, pid, **fields):
    print(json.dumps({"type": event, "pid": pid, **fields}), flush=True)


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--pid", type=int)
    cli.add_argument("--pipe")
    cli.add_argument("--discover", action="store_true")
    cli.add_argument("--list", action="store_true", help="list running QQ processes and their accounts")
    cli.add_argument("--seconds", type=int, choices=range(1, 3601), metavar="1–3600",
                     help="optional time limit for a short receive test")
    args = cli.parse_args()
    if args.list:
        instances = []
        for pid in sorted({entry[0] for entry in find_qq()}):
            try:
                self_id = AccountDetector(pid).current()
            except (OSError, ValueError, RuntimeError):
                self_id = None
            instances.append({"pid": pid, "selfId": self_id})
        print(json.dumps(instances))
        return
    pid, _, module, _ = locate_qq(pid=args.pid)
    if args.discover:
        print(pid)
        return
    if not args.pipe:
        cli.error("--pipe is required to capture")
    profile = require_build_profile(project, module)
    hook = profile["receive"]["probe"]
    duplex_module = profile.get("duplexModule")
    build = project / "build"
    duplex = bool(duplex_module and (build / duplex_module).is_file())
    detector = AccountDetector(pid)
    account = detector.current()
    if account is None:
        report("account-unresolved", pid)
        return
    commands = ParentCommands(sys.stdin.fileno())
    pending = {}
    try:
        with NativeSession(pid, build / (duplex_module if duplex else "miaoko-receive.dll"),
                           int(hook["callRva"], 16), bytes.fromhex(hook["instruction"]),
                           args.pipe, duplex=duplex) as session:
            report("attached", pid, selfId=account, duplex=duplex)
            watch = {"id": "recall-watch", "type": "watch-recalls", "params": {"startedAt": int(time())}}
            if duplex:
                pending[watch["id"]] = PendingAction(project, watch, profile, module, account)
            deadline = monotonic() + args.seconds if args.seconds is not None else None
            while session.is_running():
                for action in list(pending.values()):
                    outcome = action.poll(session, detector, account)
                    if outcome:
                        action.close()
                        del pending[action.id]
                        if action.id != watch["id"]:
                            report("action-result", pid, id=action.id, outcome=outcome)
                        elif outcome.get("error") == "QQ action queue is not ready":
                            pending[action.id] = PendingAction(project, watch, profile, module, account)
                        else:
                            report("notice-listener", pid, outcome=outcome)
                delay = 0.05
                if deadline is not None:
                    delay = min(delay, deadline - monotonic())
                if delay <= 0:
                    break
                command = commands.poll()
                if command is None:
                    sleep(delay)
                    continue
                if command == "stop":
                    break
                if command == "check":
                    current = detector.current()
                    report("account-check", pid, selfId=current)
                    if current != account:
                        break
                elif (not duplex or len(pending) >= 5 or command["selfId"] != account
                      or (command["type"] == "send-message" and
                          any(action.type == "send-message" for action in pending.values()))):
                    report("action-result", pid, id=command["id"], outcome={
                        "status": "failed", "error": "QQ action is unavailable for this session",
                    })
                else:
                    pending[command["id"]] = PendingAction(project, command, profile, module, account)
    finally:
        for action in pending.values():
            action.close()
    report("detached", pid)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        sys.exit(str(error))
    except KeyboardInterrupt:
        pass
