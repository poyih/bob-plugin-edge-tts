"""验证音色维护工具的签名请求和故障分类，不访问网络。"""
import contextlib
import io
import json
import sys
import unittest
import urllib.error
from email.message import Message
from unittest import mock
from urllib.parse import parse_qs, urlsplit

import check_voices


class VoiceMaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.config = (check_voices.SRC / "config.js").read_text(encoding="utf-8")

    def response(self, voices):
        return io.BytesIO(json.dumps(voices).encode("utf-8"))

    def rejection(self, code, server_date=None):
        headers = Message()
        if server_date:
            headers["Date"] = server_date
        return urllib.error.HTTPError("https://api.msedgeservices.com", code, "rejected", headers, io.BytesIO())

    def run_main(self, side_effect):
        output = io.StringIO()
        with mock.patch.object(sys, "argv", ["check_voices.py"]), \
                mock.patch.object(check_voices.urllib.request, "urlopen", side_effect=side_effect), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            status = check_voices.main()
        return status, output.getvalue()

    def test_fetch_uses_signed_list_on_synthesis_host(self):
        voices = [{"ShortName": "zh-CN-XiaoxiaoNeural"}]
        with mock.patch.object(check_voices.time, "time", return_value=1700000000), \
                mock.patch.object(check_voices.urllib.request, "urlopen", return_value=self.response(voices)) as fetch:
            self.assertEqual(check_voices.fetch_voices(self.config), voices)
        url = urlsplit(fetch.call_args.args[0].full_url)
        self.assertEqual(url.hostname, "api.msedgeservices.com")
        self.assertEqual(url.path, "/tts/cognitiveservices/voices/list")
        query = parse_qs(url.query)
        self.assertEqual(query["Ocp-Apim-Subscription-Key"], ["6A5AA1D4EAFF4E9FB37E23D68491D6F4"])
        self.assertEqual(query["Sec-MS-GEC"], ["42301B335578FEFDAE2637DED1ABD614505D432559EC08032B82048483726AFF"])
        self.assertNotIn("trustedclienttoken", query)

    def test_clock_skew_is_corrected_from_403_date(self):
        voices = [{"ShortName": "en-US-AriaNeural"}]
        error = self.rejection(403, "Sun, 27 Sep 2026 03:10:14 GMT")
        with mock.patch.object(check_voices.time, "time", return_value=1790479214), \
                mock.patch.object(check_voices.urllib.request, "urlopen", side_effect=[error, self.response(voices)]) as fetch:
            self.assertEqual(check_voices.fetch_voices(self.config), voices)
        self.assertEqual(fetch.call_count, 2)
        corrected = parse_qs(urlsplit(fetch.call_args.args[0].full_url).query)
        self.assertEqual(corrected["Sec-MS-GEC"], ["E4C4F86613D52B4AD21C1129AB2E52A658B8B0ADF200580B838CD1AE4ADF0ECD"])

    def test_403_with_correct_clock_does_not_retry_unchanged_signature(self):
        error = self.rejection(403, "Sun, 27 Sep 2026 03:10:14 GMT")
        with mock.patch.object(check_voices.time, "time", return_value=1790478614), \
                mock.patch.object(check_voices.urllib.request, "urlopen", side_effect=error) as fetch:
            with self.assertRaises(urllib.error.HTTPError):
                check_voices.fetch_voices(self.config)
        self.assertEqual(fetch.call_count, 1)

    def test_404_is_request_failure_instead_of_removed_voices(self):
        status, output = self.run_main(self.rejection(404))
        self.assertEqual(status, 2)
        self.assertIn("请求音色列表失败", output)
        self.assertNotIn("已不在音色列表", output)

    def test_empty_200_list_is_request_failure_instead_of_mass_removal(self):
        status, output = self.run_main([self.response([])])
        self.assertEqual(status, 2)
        self.assertIn("音色列表为空或响应格式无效", output)
        self.assertNotIn("已不在音色列表", output)


if __name__ == "__main__":
    unittest.main()
