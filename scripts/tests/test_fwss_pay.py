import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT))

from scenarios.test_fwss_pay_v2 import choose_mode, summarize  # noqa: E402


class PayModeTests(unittest.TestCase):
    def test_exported_pay_v2_wins_over_an_upgrade_request(self):
        devnet = {"contracts": {"filecoin_pay_v2_addr": "0x01"}}
        environ = {"FWSS_PAY_SERVICES_REPO": "/r", "FWSS_PAY_CANDIDATE": "abc"}
        self.assertEqual(choose_mode(devnet, environ), "v2")

    def test_upgrade_needs_both_repository_and_candidate(self):
        self.assertEqual(
            choose_mode(
                {"contracts": {}},
                {"FWSS_PAY_SERVICES_REPO": "/r", "FWSS_PAY_CANDIDATE": "abc"},
            ),
            "upgrade",
        )
        self.assertEqual(
            choose_mode({"contracts": {}}, {"FWSS_PAY_SERVICES_REPO": "/r"}),
            "baseline",
        )

    def test_only_fail_and_fixed_fail_the_run(self):
        steps = [
            {"name": "a", "phase": "prepare", "status": "PASS"},
            {"name": "b", "phase": "continue", "status": "PENDING", "detail": "x\ny"},
            {"name": "c", "phase": "continue", "status": "BLOCKED"},
        ]
        lines, failed = summarize(steps)
        self.assertFalse(failed)
        self.assertIn("PENDING  continue b (x)", lines)
        for status in ("FAIL", "FIXED"):
            _, failed = summarize(
                steps + [{"name": "d", "phase": "v2", "status": status}]
            )
            self.assertTrue(failed, status)


class PayFlagTests(unittest.TestCase):
    def test_run_py_rejects_pay_only_with_other_orders(self):
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scenarios/run.py"),
                "--fwss-pay-only",
                "--fwss-pay",
            ],
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--fwss-pay-only runs on its own", result.stderr)

    def test_regression_runner_records_the_in_place_upgrade(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "services"
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "-c",
                    "user.name=T",
                    "-c",
                    "user.email=t@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "c",
                ],
                check=True,
            )
            script = ROOT / "scripts/run-fwss-regression.py"
            base = [
                sys.executable,
                str(script),
                "--services-repo",
                str(repo),
                "--baseline",
                "HEAD",
                "--candidate",
                "HEAD",
                "--prepare-only",
            ]
            conflict = subprocess.run(
                [
                    *base,
                    "--output",
                    str(Path(tmp) / "x"),
                    "--fwss-pay",
                    "--fwss-pay-only",
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(conflict.returncode, 0)
            self.assertIn("exclusive", conflict.stderr)
            subprocess.run(
                [*base, "--output", str(Path(tmp) / "pay"), "--fwss-pay"],
                check=True,
                capture_output=True,
            )
            report = json.loads((Path(tmp) / "pay/comparison.json").read_text())
            self.assertIn("test_fwss_pay_v2", report["migration"])
            subprocess.run(
                [*base, "--output", str(Path(tmp) / "plain")],
                check=True,
                capture_output=True,
            )
            report = json.loads((Path(tmp) / "plain/comparison.json").read_text())
            self.assertEqual(report["migration"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
