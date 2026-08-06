"""
Example OAuth resume hook for Telegram/mobile Google reauthentication.

Copy to ~/.pa/oauth_resume_hook.py and customize the action registry for your
deployment. The bot calls this after `/auth ...` succeeds and passes the saved
resume_action as a base64-encoded JSON object.
"""

import argparse
import base64
import json
import os
import subprocess
import sys


def parse_args():
    parser = argparse.ArgumentParser(description="Example OAuth resume hook")
    parser.add_argument("--resume-action-base64", required=True, help="Base64-encoded JSON resume action")
    return parser.parse_args()


def load_action(encoded: str) -> dict:
    raw = base64.b64decode(encoded).decode("utf-8")
    action = json.loads(raw)
    if not isinstance(action, dict):
        raise ValueError("resume action must decode to a JSON object")
    return action


def dispatch(action: dict) -> int:
    action_type = action.get("type")
    cwd = os.environ.get("BOT_CWD") or os.getcwd()

    if action_type in {"run_pa_skill", "legacy_pa_run_skill"}:
        skill = action.get("skill")
        if not isinstance(skill, str) or not skill.strip():
            raise ValueError("run_pa_skill requires a non-empty string `skill`")

        cmd = ["pa", "run", skill]
        worker = action.get("worker")
        if isinstance(worker, str) and worker.strip():
            cmd.extend(["--worker", worker])

        extra_args = action.get("args")
        if isinstance(extra_args, list) and extra_args:
            cmd.append("--")
            cmd.extend(str(item) for item in extra_args)

        subprocess.Popen(cmd, cwd=cwd, shell=True)
        return 0

    raise ValueError(f"Unsupported resume action type: {action_type!r}")


def main() -> int:
    try:
        args = parse_args()
        action = load_action(args.resume_action_base64)
        return dispatch(action)
    except Exception as exc:
        print(f"[oauth_resume_hook] {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
