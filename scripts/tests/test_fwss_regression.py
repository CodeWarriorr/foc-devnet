import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / "run-fwss-regression.py"


class RegressionCommandTests(unittest.TestCase):
    def test_refuses_existing_devnet_before_any_lifecycle_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init", "-q", str(root / "repo")], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(root / "repo"),
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "initial",
                ],
                check=True,
            )
            docker = root / "docker"
            docker.write_text("#!/bin/sh\necho 'foc-existing-lotus foc-lotus:latest'\n")
            docker.chmod(0o700)
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--services-repo",
                    str(root / "repo"),
                    "--baseline",
                    "HEAD",
                    "--candidate",
                    "HEAD",
                    "--output",
                    str(root / "result"),
                ],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"]},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            report = json.loads((root / "result/comparison.json").read_text())
            self.assertIn("Existing foc-devnet", report["error"])
            self.assertFalse((root / "result/baseline").exists())

    def test_failed_baseline_does_not_hide_candidate_or_report_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "services"
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    "160000," + "1" * 40 + ",service_contracts/lib/pdp",
                ],
                check=True,
            )
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-qm",
                    "baseline",
                ],
                check=True,
            )
            binary = root / "foc-devnet"
            binary.write_text("#!/bin/sh\nprintf 'broken setup\\n'\nexit 9\n")
            binary.chmod(0o700)
            docker = root / "docker"
            docker.write_text("#!/bin/sh\nexit 0\n")
            docker.chmod(0o700)
            deps = root / "dependencies.json"
            deps.write_text(
                json.dumps(
                    {
                        "components": {
                            name: {
                                "source": "config_default",
                                "repository": "https://example.invalid/" + name,
                            }
                            for name in [
                                "lotus",
                                "curio",
                                "pdp",
                                "filecoin-services",
                                "synapse-sdk",
                                "filecoin-pin",
                            ]
                        }
                    }
                )
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--services-repo",
                    str(repo),
                    "--baseline",
                    "HEAD",
                    "--candidate",
                    "HEAD",
                    "--output",
                    str(root / "result"),
                    "--binary",
                    str(binary),
                    "--dependencies",
                    str(deps),
                ],
                env={**os.environ, "PATH": str(root) + os.pathsep + os.environ["PATH"]},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            report = json.loads((root / "result" / "comparison.json").read_text())
            self.assertEqual(report["status"], "FAIL")
            for side in ["baseline", "candidate"]:
                self.assertEqual(report[side]["status"], "FAIL")
                self.assertEqual(report[side]["failed_step"], "init")

    def test_prepare_resolves_configurable_baseline_and_candidate_without_a_network(
        self,
    ):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / "services"
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "baseline",
                ],
                check=True,
            )
            baseline = subprocess.check_output(
                ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
            ).strip()
            subprocess.run(["git", "-C", str(repo), "tag", "release"], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(repo),
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "--allow-empty",
                    "-qm",
                    "candidate",
                ],
                check=True,
            )
            candidate = subprocess.check_output(
                ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
            ).strip()
            command = [
                sys.executable,
                str(SCRIPT),
                "--services-repo",
                str(repo),
                "--baseline",
                "release",
                "--candidate",
                "HEAD",
                "--output",
                str(root / "result"),
                "--prepare-only",
            ]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((root / "result" / "comparison.json").read_text())
            self.assertEqual(report["baseline"]["commit"], baseline)
            self.assertEqual(report["candidate"]["commit"], candidate)
            self.assertEqual(report["status"], "NOT_RUN")
            self.assertNotEqual(
                subprocess.run(command, capture_output=True).returncode,
                0,
                "must not overwrite existing run",
            )

    def test_cleanup_guard_allows_only_owned_run(self):
        import importlib.util
        from unittest.mock import patch

        spec = importlib.util.spec_from_file_location("regression", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        own = "20260918T1200_Test"
        with patch.object(
            module.subprocess,
            "check_output",
            side_effect=[f"foc-{own}-lotus foc-lotus:latest\n", f"foc_{own}_lot-net\n"],
        ):
            module.require_unused_devnet_daemon(own)
        with patch.object(
            module.subprocess,
            "check_output",
            return_value="foc-other-lotus foc-lotus:latest\n",
        ):
            with self.assertRaises(ValueError):
                module.require_unused_devnet_daemon(own)
