"""Send one group text through the existing Windows QQ session."""
import argparse
import json
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / "src" / "qq"))
from actions.runtime import run_action


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--pid", type=int)
    cli.add_argument("--group", required=True)
    cli.add_argument("--pipe", required=True)
    cli.add_argument("--bubble-from")
    args = cli.parse_args()
    text = sys.stdin.buffer.read(1025).decode("utf-8")
    if (not re.fullmatch(r"[1-9]\d{4,11}", args.group, flags=re.ASCII)
            or not text.strip() or "\0" in text or len(text.encode()) > 1024):
        cli.error("Expected a group number and 1–1024 bytes of UTF-8 text")
    if args.bubble_from is not None and not re.fullmatch(r"[1-9][0-9]{0,19}", args.bubble_from):
        cli.error("--bubble-from expects a QQ message ID")

    outcome = run_action(root, "sendGroupText", {
        "group": args.group,
        "text": text,
        "bubbleFrom": args.bubble_from,
    }, pid=args.pid, pipe=args.pipe)
    print(json.dumps(outcome, ensure_ascii=False))
    return 0 if outcome["status"] == "sent" else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        sys.exit(str(error))
