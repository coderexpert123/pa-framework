#!/usr/bin/env python3
"""
Deterministic scorer for date arithmetic (Ekadashi-style).
Validates that the output contains a date in the expected range.
"""
import re
import sys
import json
from datetime import datetime, timedelta

def score(output: str) -> dict:
    """
    Score the output for date arithmetic correctness.
    The next Ekadashi after 2026-08-18 should be 2026-08-25 (11 days later).
    We accept dates within ±1 day to account for interpretation.
    """
    # Match ISO date format YYYY-MM-DD
    date_match = re.search(r'\d{4}-\d{2}-\d{2}', output)
    if not date_match:
        return {
            "pass": False,
            "detail": "No date found in ISO format (YYYY-MM-DD)"
        }

    try:
        output_date = datetime.strptime(date_match.group(), '%Y-%m-%d')
        expected_date = datetime(2026, 8, 25)  # 11 days after 2026-08-14 (Ekadashi) + cycle

        # Allow ±1 day tolerance
        diff = abs((output_date - expected_date).days)
        if diff <= 1:
            return {
                "pass": True,
                "detail": f"Date {date_match.group()} is within acceptable range of {expected_date.strftime('%Y-%m-%d')}"
            }
        else:
            return {
                "pass": False,
                "detail": f"Date {date_match.group()} is {diff} days from expected {expected_date.strftime('%Y-%m-%d')}"
            }
    except ValueError as e:
        return {
            "pass": False,
            "detail": f"Invalid date format: {e}"
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
