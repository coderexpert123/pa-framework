#!/usr/bin/env python3
"""
Deterministic scorer for markdown shape.
Validates that output parses as valid Markdown without throwing.
This is a structural check - we verify the output has markdown-like structure.
"""
import re
import sys
import json

def score(output: str) -> dict:
    """
    Score the output for markdown structure.
    Checks for common markdown patterns: headers, bold, lists.
    """
    # Check for basic markdown structures
    has_header = bool(re.search(r'^#{1,6}\s+', output, re.MULTILINE))
    has_bold = bool(re.search(r'\*\*.*?\*\*', output))
    has_list = bool(re.search(r'^[\s]*[-*+]\s+', output, re.MULTILINE))

    # At least one markdown pattern should be present
    if has_header or has_bold or has_list:
        patterns_found = []
        if has_header: patterns_found.append("header")
        if has_bold: patterns_found.append("bold")
        if has_list: patterns_found.append("list")

        return {
            "pass": True,
            "detail": f"Output contains markdown structure: {', '.join(patterns_found)}"
        }
    else:
        return {
            "pass": False,
            "detail": "Output does not contain recognizable markdown structure (no headers, bold, or lists)"
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
