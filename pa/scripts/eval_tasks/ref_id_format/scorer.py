#!/usr/bin/env python3
"""
Deterministic scorer for ref-ID emission format check.
Validates that output contains a properly formatted ref-ID: _Ref: s-[0-9a-f]{12}_
"""
import re
import sys
import json

def score(output: str) -> dict:
    """
    Score the output for ref-ID format compliance.
    Returns dict with pass (bool) and detail (str).
    """
    pattern = r'_Ref: s-[0-9a-f]{12}_'
    matches = re.findall(pattern, output)

    if matches:
        return {
            "pass": True,
            "detail": f"Found {len(matches)} properly formatted ref-ID(s)"
        }
    else:
        return {
            "pass": False,
            "detail": "No properly formatted ref-ID found (expected _Ref: s-[0-9a-f]{12}_)"
        }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"pass": False, "detail": "No output provided"}))
        sys.exit(1)

    output_path = sys.argv[1]
    with open(output_path, 'r', encoding='utf-8') as f:
        output = f.read()

    result = score(output)
    print(json.dumps(result))
    sys.exit(0 if result["pass"] else 1)
