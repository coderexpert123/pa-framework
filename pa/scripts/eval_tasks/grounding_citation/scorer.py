#!/usr/bin/env python3
"""
Deterministic scorer for grounding citation.
Validates that the output contains the cited filename from the source.
"""
import sys
import json

def score(output: str) -> dict:
    """
    Score the output for grounding citation correctness.
    The output should mention 'health.md' as the file containing medical records.
    """
    expected_filename = 'health.md'
    output_lower = output.lower()

    if expected_filename in output_lower:
        return {
            "pass": True,
            "detail": f"Output correctly cites the expected filename: {expected_filename}"
        }
    else:
        return {
            "pass": False,
            "detail": f"Output does not cite the expected filename: {expected_filename}"
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
