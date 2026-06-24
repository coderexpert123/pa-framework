import unittest
import os
import json
import secrets
from unittest.mock import patch, MagicMock
from telegram_notify import notify

class TestTelegramNotifyRefId(unittest.TestCase):
    def setUp(self):
        self.temp_pa_home = os.path.join(os.getcwd(), "temp_pa_home_test")
        os.makedirs(self.temp_pa_home, exist_ok=True)
        self.log_path = os.path.join(self.temp_pa_home, "app.log.jsonl")
        if os.path.exists(self.log_path):
            os.remove(self.log_path)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.temp_pa_home)

    @patch("telegram_notify.requests.post")
    def test_notify_appends_ref_id_and_logs(self, mock_post):
        # Clear specific env vars that might leak from the real environment
        with patch.dict(os.environ, {
            "PA_HOME": self.temp_pa_home,
            "TELEGRAM_BOT_TOKEN": "fake-token",
            "TELEGRAM_CHAT_ID": "-100",
        }, clear=True):
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_post.return_value = mock_resp

            notify("Hello Python")

        # Check mock call
        call_args = mock_post.call_args
        payload = call_args[1]["json"]
        self.assertIn("_Ref: s-", payload["text"])
        
        # Extract refId from payload
        import re
        match = re.search(r"_Ref: (s-[0-9a-f]{4})_$", payload["text"])
        self.assertTrue(match)
        ref_id = match.group(1)

        # Check log file
        with open(self.log_path, "r", encoding="utf-8") as f:
            logs = [json.loads(line) for line in f]
        
        self.assertEqual(len(logs), 1)
        self.assertEqual(logs[0]["message"], "skill message sent")
        self.assertEqual(logs[0]["refId"], ref_id)
        self.assertEqual(logs[0]["chatId"], -100)

if __name__ == "__main__":
    unittest.main()
