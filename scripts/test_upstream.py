"""验证上游监测只放行精确的已知端点差异，其他漂移仍失败，对照通过时关闭漂移 issue；不访问网络。"""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import check_upstream
from test_release import ROOT, workflow_step

FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ["FAKE_GH_DIR"])
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")
if args[:2] == ["issue", "list"]:
    for number in json.loads((root / "open-issues.json").read_text()):
        print(number)
elif args[:2] != ["issue", "close"]:
    raise SystemExit("unexpected gh invocation: " + repr(args))
'''


class UpstreamMonitoringTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "TRUSTED_CLIENT_TOKEN": "fixture-token",
            "CHROMIUM_FULL_VERSION": "143.0.3650.75",
            "CHROMIUM_MAJOR_VERSION": "143",
            "SEC_MS_GEC_VERSION": "2-143.0.3650.75",
            "BASE_URL": "speech.platform.bing.com/consumer/speech/synthesize/readaloud",
            "WSS_URL": "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1",
            "VOICE_LIST_URL": "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=fixture-token",
            "USER_AGENT": "fixture-agent",
            "ORIGIN": "fixture-origin",
            "ACCEPT_LANGUAGE": "en-US,en;q=0.9",
        }
        self.headers = {"User-Agent": "fixture-agent"}
        self.upstream = {
            "TRUSTED_CLIENT_TOKEN": self.config["TRUSTED_CLIENT_TOKEN"],
            "CHROMIUM_FULL_VERSION": self.config["CHROMIUM_FULL_VERSION"],
            "SEC_MS_GEC_VERSION": self.config["SEC_MS_GEC_VERSION"],
            "BASE_URL": self.config["BASE_URL"],
            "WSS_URL": "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=fixture-token",
            "VOICE_LIST": self.config["VOICE_LIST_URL"],
            "WSS_HEADERS": self.headers.copy(),
        }

    def compare(self):
        problems = []
        rows = check_upstream.compare_all(self.config, self.headers, self.upstream, problems)
        return rows, problems

    def test_exact_known_endpoint_pair_passes_with_reason(self):
        rows, problems = self.compare()
        self.assertEqual(problems, [])
        self.assertTrue(all(row["ok"] for row in rows))
        known = [row for row in rows if row["known_difference"]]
        self.assertEqual(len(known), 1)
        self.assertEqual(known[0]["label"], "WebSocket 地址")
        self.assertIn("保留已验证的新合成端点", known[0]["note"])
        self.assertEqual((known[0]["ours"], known[0]["theirs"]),
                         check_upstream.KNOWN_WSS_ENDPOINT_DIFFERENCE)

    def test_upstream_adopting_current_endpoint_is_an_exact_match(self):
        self.upstream["WSS_URL"] = self.config["WSS_URL"] + "?Ocp-Apim-Subscription-Key=fixture-token"
        rows, problems = self.compare()
        self.assertEqual(problems, [])
        self.assertTrue(all(row["ok"] for row in rows))
        self.assertFalse(any(row["known_difference"] for row in rows))

    def test_unknown_upstream_websocket_changes_fail(self):
        for endpoint in (
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v2",
            "wss://unknown.example/consumer/speech/synthesize/readaloud/edge/v1",
            "ws://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1",
        ):
            with self.subTest(endpoint=endpoint):
                self.upstream["WSS_URL"] = endpoint
                rows, problems = self.compare()
                self.assertEqual(problems, [])
                self.assertEqual([row["label"] for row in rows if not row["ok"]], ["WebSocket 地址"])
                self.assertFalse(any(row["known_difference"] for row in rows))

    def test_unknown_plugin_websocket_changes_fail(self):
        for endpoint in (
            "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v2",
            "wss://unknown.example/tts/cognitiveservices/websocket/v1",
            "ws://api.msedgeservices.com/tts/cognitiveservices/websocket/v1",
        ):
            with self.subTest(endpoint=endpoint):
                self.config["WSS_URL"] = endpoint
                rows, problems = self.compare()
                self.assertEqual(problems, [])
                self.assertEqual([row["label"] for row in rows if not row["ok"]], ["WebSocket 地址"])
                self.assertFalse(any(row["known_difference"] for row in rows))

    def test_known_websocket_difference_does_not_hide_other_drift(self):
        for name, value, label in (
            ("SEC_MS_GEC_VERSION", "3-143.0.3650.75", "Sec-MS-GEC-Version"),
            ("CHROMIUM_FULL_VERSION", "144.0.0.0", "CHROMIUM_FULL_VERSION（浏览器版本号）"),
            ("TRUSTED_CLIENT_TOKEN", "new-token", "TRUSTED_CLIENT_TOKEN"),
            ("BASE_URL", "unknown.example/new/base", "BASE_URL（接口域名与路径）"),
            ("VOICE_LIST", "https://unknown.example/voices/list", "音色列表地址"),
            ("WSS_HEADERS", {"User-Agent": "new-agent"}, "握手头 User-Agent"),
        ):
            with self.subTest(name=name):
                old = self.upstream[name]
                self.upstream[name] = value
                rows, problems = self.compare()
                self.assertEqual(problems, [])
                self.assertEqual([row["label"] for row in rows if not row["ok"]], [label])
                self.assertEqual(sum(row["known_difference"] for row in rows), 1)
                self.upstream[name] = old

    def test_missing_signature_constant_still_reports_parse_problem(self):
        del self.upstream["SEC_MS_GEC_VERSION"]
        rows, problems = self.compare()
        self.assertEqual(sum(row["known_difference"] for row in rows), 1)
        self.assertEqual(len(problems), 1)
        self.assertIn("SEC_MS_GEC_VERSION", problems[0])

    def report(self):
        rows, problems = self.compare()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "report.md"
            check_upstream.write_report(path, rows, problems, "fixture-version", "fixture-version")
            return path.read_text(encoding="utf-8")

    def test_success_report_explains_known_difference(self):
        report = self.report()
        self.assertIn("已知差异", report)
        self.assertIn("其余项目一致，无新增漂移", report)
        self.assertNotIn("全部一致", report)
        self.assertNotIn("### 处理办法", report)

    def test_drift_report_preserves_endpoint_and_requires_signature_review(self):
        self.upstream["SEC_MS_GEC_VERSION"] = "3-143.0.3650.75"
        report = self.report()
        self.assertIn("**不一致**", report)
        self.assertIn("新合成端点继续保留", report)
        self.assertIn("不要为了与上游一致而改回旧地址", report)
        self.assertIn("不能只改版本标记", report)
        self.assertNotIn("把上游的新值写进", report)

    def run_local_main(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            config_source = "\n".join(f"var {name} = {json.dumps(value)};"
                                      for name, value in self.config.items())
            (source / "config.js").write_text(config_source, encoding="utf-8")
            (source / "protocol.js").write_text(
                'function buildHeaders() { return {"User-Agent": config.USER_AGENT}; }', encoding="utf-8")
            constants = source / "constants.py"
            constants.write_text("\n".join(f"{name} = {value!r}" for name, value in self.upstream.items()),
                                 encoding="utf-8")
            output = io.StringIO()
            with mock.patch.object(check_upstream, "SRC", source), \
                    mock.patch.object(sys, "argv", ["check_upstream.py", "--upstream-file", str(constants)]), \
                    mock.patch.object(check_upstream, "fetch") as fetch, \
                    contextlib.redirect_stdout(output):
                status = check_upstream.main()
            fetch.assert_not_called()
            return status, output.getvalue()

    def test_local_cli_accepts_known_endpoint_without_network(self):
        status, output = self.run_local_main()
        self.assertEqual(status, 0)
        self.assertIn("1 项已知差异", output)
        self.assertNotIn("upstream FAIL", output)

    def test_local_cli_fails_for_future_signature_drift(self):
        self.upstream["SEC_MS_GEC_VERSION"] = "3-143.0.3650.75"
        status, output = self.run_local_main()
        self.assertEqual(status, 1)
        self.assertIn("upstream FAIL  Sec-MS-GEC-Version", output)
        self.assertIn("已知新端点继续保留", output)


class UpstreamWorkflowTests(unittest.TestCase):
    """在临时目录执行 upstream.yml 里关闭 issue 的实际脚本，GitHub CLI 仅在边界替换。"""
    STEP = "对照通过时关闭 issue"

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="edge-upstream-workflow-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        (bin_dir / "gh").write_text(FAKE_GH)
        (bin_dir / "gh").chmod(0o755)
        self.env = dict(os.environ, FAKE_GH_DIR=str(self.base), GH_TOKEN="fixture-token",
                        RUN_URL="https://example.invalid/actions/runs/1",
                        PATH=str(bin_dir) + os.pathsep + os.environ["PATH"])

    def run_close_step(self, open_issues):
        (self.base / "open-issues.json").write_text(json.dumps(open_issues))
        result = subprocess.run(["bash", "-e", "-o", "pipefail", "-c", workflow_step(self.STEP, "upstream.yml")],
                                cwd=self.base, env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = self.base / "calls.jsonl"
        return [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def test_closes_every_open_drift_issue_with_run_link(self):
        calls = self.run_close_step([10, 12])
        listing = calls[0]
        self.assertEqual(listing[:2], ["issue", "list"])
        self.assertEqual(listing[listing.index("--label") + 1], "upstream-drift")
        self.assertEqual(listing[listing.index("--state") + 1], "open")
        closes = [call for call in calls if call[:2] == ["issue", "close"]]
        self.assertEqual([call[2] for call in closes], ["10", "12"])
        for call in closes:
            self.assertEqual(call[call.index("--reason") + 1], "completed")
            self.assertIn("https://example.invalid/actions/runs/1", call[call.index("--comment") + 1])

    def test_no_open_drift_issue_closes_nothing(self):
        calls = self.run_close_step([])
        self.assertEqual([call[:2] for call in calls], [["issue", "list"]])

    def test_closes_only_when_both_checks_pass(self):
        # 音色列表请求失败（退出码 2）不算通过：issue 可能正是音色缺失开的，不能就此关掉
        lines = (ROOT / ".github/workflows/upstream.yml").read_text().splitlines()
        start = lines.index("      - name: " + self.STEP)
        condition = None
        for line in lines[start + 1:]:
            if line.startswith("      - "):
                break
            if line.startswith("        if: "):
                condition = line.strip()
        self.assertEqual(condition,
                         "if: steps.upstream.outputs.status == '0' && steps.voices.outputs.status == '0'")


if __name__ == "__main__":
    unittest.main()
