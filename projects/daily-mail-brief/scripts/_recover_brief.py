import json, os, sys, time
import run_brief as rb

with open('../emails.json', encoding='utf-8') as f:
    data = json.load(f)

window = data['window']
window_end_utc_str = data.get('window_end_utc')
emails = data['emails']
total_count = len(emails)
print(f'Recovering window: {window}, {total_count} emails', flush=True)

emails_text = rb.format_emails_for_prompt(emails)
portfolio_context = rb.load_portfolio_context()
prompt = rb.build_prompt(window, total_count, emails_text, portfolio_context)


def fail_gemini(reason):
    print(f'[FAIL] {reason}', file=sys.stderr, flush=True)
    sys.exit(1)


response = None
for attempt in range(2):
    try:
        candidate = rb.call_gemini(prompt)
    except Exception as e:
        if attempt == 0:
            print(f'[WARN] attempt 1 failed, retrying: {e}', file=sys.stderr, flush=True)
            time.sleep(10)
            continue
        fail_gemini(str(e))
    if '===BRIEFING_START===' in candidate and '===BRIEFING_END===' in candidate:
        response = candidate
        break
    if attempt == 0:
        print('[WARN] attempt 1 no markers, retrying', file=sys.stderr, flush=True)
        time.sleep(10)
    else:
        fail_gemini(f'no markers after 2 attempts: {candidate[:300]}')

if response is None:
    fail_gemini('no response')

window_end_dt = rb.parse_window_end(window_end_utc_str)
b_start = response.index('===BRIEFING_START===') + len('===BRIEFING_START===')
b_end = response.index('===BRIEFING_END===')
briefing_output = response[b_start:b_end].strip()
analysis_input = ''
if '===ANALYSIS_START===' in response and '===ANALYSIS_END===' in response:
    a_start = response.index('===ANALYSIS_START===') + len('===ANALYSIS_START===')
    a_end = response.index('===ANALYSIS_END===')
    analysis_input = response[a_start:a_end].strip()

if not briefing_output or not briefing_output.startswith('[pa assert]'):
    fail_gemini(f'malformed content: {briefing_output[:300] or "<empty>"}')

with open('../briefing_output.md', 'w', encoding='utf-8') as f:
    f.write(briefing_output)
if analysis_input:
    with open('../analysis_input.md', 'w', encoding='utf-8') as f:
        f.write(analysis_input)

print('RECOVERY_OK', flush=True)
print(briefing_output[:800], flush=True)
