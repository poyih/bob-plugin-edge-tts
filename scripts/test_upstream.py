"""验证上游监测对端点与协议常量做精确对照，有漂移就失败，对照通过时关闭漂移 issue；不访问网络。"""
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
            "WSS_URL": "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1",
            "WSS_TOKEN_QUERY_NAME": "TrustedClientToken",
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

    def test_matching_constants_pass(self):
        rows, problems = self.compare()
        self.assertEqual(problems, [])
        self.assertTrue(all(row["ok"] for row in rows))
        self.assertEqual([row["label"] for row in rows if row["note"]], [])

    def test_endpoint_row_compares_path_and_token_row_compares_query(self):
        rows, _ = self.compare()
        by_label = {row["label"]: row for row in rows}
        endpoint = by_label["WebSocket 地址"]
        self.assertTrue(endpoint["ok"])
        self.assertEqual((endpoint["ours"], endpoint["theirs"]), (self.config["WSS_URL"], self.config["WSS_URL"]))
        token = by_label["WebSocket 地址的令牌参数"]
        self.assertTrue(token["ok"])
        self.assertEqual((token["ours"], token["theirs"]),
                         ("TrustedClientToken=fixture-token", "TrustedClientToken=fixture-token"))

    def test_upstream_websocket_changes_fail(self):
        for endpoint, failing in (
            ("wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v2?TrustedClientToken=fixture-token",
             ["WebSocket 地址"]),
            ("wss://unknown.example/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=fixture-token",
             ["WebSocket 地址"]),
            ("ws://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=fixture-token",
             ["WebSocket 地址"]),
            # 路径和令牌参数名都变了：两行都要报
            ("wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=fixture-token",
             ["WebSocket 地址", "WebSocket 地址的令牌参数"]),
        ):
            with self.subTest(endpoint=endpoint):
                self.upstream["WSS_URL"] = endpoint
                rows, problems = self.compare()
                self.assertEqual(problems, [])
                self.assertEqual([row["label"] for row in rows if not row["ok"]], failing)

    def test_upstream_token_query_changes_fail_even_when_path_matches(self):
        path = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1"
        for query in ("?Ocp-Apim-Subscription-Key=fixture-token", "", "?TrustedClientToken=fixture-token&Region=cn",
                      "?TrustedClientToken=other-token"):
            with self.subTest(query=query):
                self.upstream["WSS_URL"] = path + query
                rows, problems = self.compare()
                self.assertEqual(problems, [])
                self.assertEqual([row["label"] for row in rows if not row["ok"]], ["WebSocket 地址的令牌参数"])
        row = next(row for row in rows if row["label"] == "WebSocket 地址的令牌参数")
        self.assertEqual(row["theirs"], "TrustedClientToken=other-token")
        self.upstream["WSS_URL"] = path
        rows, _ = self.compare()
        row = next(row for row in rows if row["label"] == "WebSocket 地址的令牌参数")
        self.assertIn("没有 query", row["theirs"])

    def test_plugin_token_query_name_drift_fails(self):
        self.config["WSS_TOKEN_QUERY_NAME"] = "Ocp-Apim-Subscription-Key"
        rows, problems = self.compare()
        self.assertEqual(problems, [])
        self.assertEqual([row["label"] for row in rows if not row["ok"]], ["WebSocket 地址的令牌参数"])

    def test_plugin_websocket_changes_fail(self):
        for endpoint in (
            # 1.2.2 至 1.3.0 用过的地址，2026-10-26 起只回 200，不再是已知差异
            "wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1",
            "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v2",
            "ws://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1",
        ):
            with self.subTest(endpoint=endpoint):
                self.config["WSS_URL"] = endpoint
                rows, problems = self.compare()
                self.assertEqual(problems, [])
                self.assertEqual([row["label"] for row in rows if not row["ok"]], ["WebSocket 地址"])

    def test_each_kind_of_drift_is_reported_by_label(self):
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
                self.upstream[name] = old

    def test_missing_signature_constant_reports_parse_problem(self):
        del self.upstream["SEC_MS_GEC_VERSION"]
        rows, problems = self.compare()
        self.assertTrue(all(row["ok"] for row in rows))
        self.assertEqual(len(problems), 1)
        self.assertIn("SEC_MS_GEC_VERSION", problems[0])

    def report(self):
        rows, problems = self.compare()
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "report.md"
            check_upstream.write_report(path, rows, problems, "fixture-version", "fixture-version")
            return path.read_text(encoding="utf-8")

    def test_success_report_says_everything_matches(self):
        report = self.report()
        self.assertIn("全部一致，不需要更新", report)
        self.assertNotIn("已知差异", report)
        self.assertNotIn("### 处理办法", report)

    def test_drift_report_requires_verifying_endpoint_and_signature_changes(self):
        self.upstream["SEC_MS_GEC_VERSION"] = "3-143.0.3650.75"
        report = self.report()
        self.assertIn("**不一致**", report)
        self.assertIn("### 处理办法", report)
        self.assertIn("确认新地址能完成握手并返回音频", report)
        self.assertIn("不能只改版本标记", report)
        self.assertNotIn("已知差异", report)
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

    def test_local_cli_passes_without_network(self):
        status, output = self.run_local_main()
        self.assertEqual(status, 0)
        self.assertIn("constants.py 一致（", output)
        self.assertNotIn("upstream FAIL", output)
        self.assertNotIn("已知差异", output)

    def test_local_cli_fails_for_signature_drift(self):
        self.upstream["SEC_MS_GEC_VERSION"] = "3-143.0.3650.75"
        status, output = self.run_local_main()
        self.assertEqual(status, 1)
        self.assertIn("upstream FAIL  Sec-MS-GEC-Version", output)
        self.assertIn("请逐项核实", output)


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
