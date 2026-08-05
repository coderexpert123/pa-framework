import re
import sys

# Force UTF-8 output
sys.stdout.reconfigure(encoding='utf-8')

def _gfm_to_telegram_markdown(text: str) -> str:
    text = re.sub(r"(?m)^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", "\x00\\1\x00", text)
    text = re.sub(r"\*\*(\S(?:.*?\S)?)\*\*", "\x00\\1\x00", text)
    text = re.sub(r"(?<!\*)\*(\S(?:.*?\S)?)\*(?!\*)", r"_\1_", text)
    text = text.replace("\x00", "*")
    text = re.sub(r"~~(.+?)~~", r"\1", text)
    return text

input_text = """### Daily Briefing: July 29, 2026

---

### 📈 Market Alpha
* **Big Tech Earnings Crucible**"""

print("INPUT:\n", repr(input_text))
print("OUTPUT:\n", repr(_gfm_to_telegram_markdown(input_text)))
