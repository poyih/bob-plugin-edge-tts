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
        self.assertEqual(query["Sec-MS-GEC"], [
            "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2"
        ])
        self.assertEqual(query["Sec-MS-GEC-Version"], ["2-143.0.3650.75"])
        self.assertNotIn("trustedclienttoken", query)

    def test_v2_signatures_match_fixed_vectors(self):
        vectors = {
            0: "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
            1700000000: "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
            1790478614: "4D1DB9C4575C6B6A-7BBC888A7FC4B9BD002D9FD2177394DFAF3C1D77FA2F89D691824527C6800C77",
            1791888000: "492D7694A183A45E-56E821F95D4579C5B7C7E33DC7303FF379EC36D510213555BBBB9EB17EF15876",
            4102444800: "DD230DB44FEE2FD7-DA0D4FA797866E36C992FABB81DD2F9DB37EB74D675D63228277003DCD3F9F8C",
            32503680000: "A11764942C43F123-56D2028B211C17F806379CD879EE28B9C2F269BBA93564B8AC92699DD3A8D134",
        }
        for seconds, expected in vectors.items():
            with self.subTest(seconds=seconds):
                query = parse_qs(urlsplit(check_voices.voice_list_url(self.config, seconds)).query)
                self.assertEqual(query["Sec-MS-GEC"], [expected])

    def test_fractions_share_a_five_minute_signature_window(self):
        def signature(seconds):
            return parse_qs(urlsplit(check_voices.voice_list_url(self.config, seconds)).query)["Sec-MS-GEC"]

        # 这几个时刻各自位于窗口起点，未来年份也必须使用精确整数 ticks。
        for start in (1699999800, 4102444800, 32503680000):
            with self.subTest(start=start):
                expected = signature(start)
                self.assertEqual(signature(start + 0.125), expected)
                self.assertEqual(signature(start + 299.875), expected)
                self.assertNotEqual(signature(start - 0.125), expected)
                self.assertNotEqual(signature(start + 300), expected)
        self.assertEqual(signature(-0.125), signature(-1))
        self.assertNotEqual(signature(-0.125), signature(0))

    def test_clock_skew_is_corrected_from_403_date(self):
        voices = [{"ShortName": "en-US-AriaNeural"}]
        error = self.rejection(403, "Sun, 27 Sep 2026 03:10:14 GMT")
        with mock.patch.object(check_voices.time, "time", return_value=1790479214), \
                mock.patch.object(check_voices.urllib.request, "urlopen", side_effect=[error, self.response(voices)]) as fetch:
            self.assertEqual(check_voices.fetch_voices(self.config), voices)
        self.assertEqual(fetch.call_count, 2)
        corrected = parse_qs(urlsplit(fetch.call_args.args[0].full_url).query)
        self.assertEqual(corrected["Sec-MS-GEC"], [
            "4D1DB9C4575C6B6A-7BBC888A7FC4B9BD002D9FD2177394DFAF3C1D77FA2F89D691824527C6800C77"
        ])
        self.assertEqual(corrected["Sec-MS-GEC-Version"], ["2-143.0.3650.75"])

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
