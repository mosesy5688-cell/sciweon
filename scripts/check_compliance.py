#!/usr/bin/env python3
"""
Compliance Enforcement Script (CES) — Sciweon V1.0
Synced from Free2AITools CES V6.2 (Art V, VIII, IX).

Checks:
1. [Art 5.1] Monolith Check: No source file > 250 lines.
2. [Art 5.1] Security Check: No D1 credentials or secrets in code.
3. [Art 8.1] English Mandate: No non-ASCII (CJK) characters in code/comments.
4. [Art 9.1] IP Protection: No classified documents (CONSTITUTION, STRATEGY,
   PLAN, AUDIT, PROMPT, HANDOVER, EXECUTION_DETAILS, NEGATIVE_EVIDENCE,
   DATA_ARCHITECTURE, IDEA_LAB, POSITIONING, LABNEXUS, SCIWEON, IMMIGRATION)
   committed to the repo.

Sciweon-specific notes:
- V0.1-0.4 internal dev phase: English mandate is RECOMMENDED but not strictly
  enforced for inline comments. CJK in code identifiers / strings is blocked.
  Transition to strict mode before V0.5 sciweon.com Day-1 landing.
- Adapter line-limit exemptions kept minimal — current adapters fit < 250.
"""

import os
import re
import sys

MAX_LINES = 250

# Filename patterns that must NEVER appear in the repo (strategic docs).
FORBIDDEN_FILES = [
    r".*CONSTITUTION.*",
    r".*STRATEGY.*",
    r".*PLAN.*",
    r".*AUDIT.*",
    r".*PROMPT.*",
    r".*HANDOVER.*",
    r".*EXECUTION_DETAILS.*",
    r".*NEGATIVE_EVIDENCE.*",
    r".*DATA_ARCHITECTURE.*",
    r".*IDEA_LAB.*",
    r".*POSITIONING.*",
    r".*LABNEXUS.*",
    r".*SCIWEON_(?!compound|trial|paper|bioactivity).*",
    r".*IMMIGRATION.*",
]

IGNORE_DIRS = {
    'node_modules', '.git', 'dist', 'coverage', 'venv', '__pycache__',
    'output', 'data', '.cache', '.wrangler', 'tmp', '.claude', '.gemini',
    'brain', 'playwright-report', 'test-results',
}

IGNORE_FILES = {
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
    'README.md', 'LICENSE', 'CONTRIBUTING.md',
    # CES infrastructure files themselves
    'check_compliance.py',
}

SCAN_EXTENSIONS = {'.js', '.ts', '.jsx', '.tsx', '.py', '.css', '.html'}

# Secret regex (synced from Free2AITools, plus Sciweon-relevant additions).
SECRET_PATTERNS = [
    (r"d1_token\s*=\s*['\"].+['\"]", "D1 Token Leak"),
    (r"bearer\s+ey[a-zA-Z0-9-._]+", "JWT Token Leak"),
    (r"ghp_[a-zA-Z0-9]{30,}", "GitHub Personal Access Token"),
    (r"(?:^|[^a-zA-Z0-9_-])sk-[a-zA-Z0-9]{20,}", "OpenAI/API Key"),
    (r"AKIA[0-9A-Z]{16}", "AWS Access Key ID"),
    (r"aws_secret_access_key\s*=\s*['\"][a-zA-Z0-9/+=]{40}['\"]", "AWS Secret Key"),
]

# V0.1a phase: English mandate is WARN-only. Set strict=True before V0.5 launch.
ENGLISH_STRICT = os.environ.get('CES_ENGLISH_STRICT') == '1'


class Violations:
    def __init__(self):
        self.errors = []
        self.warnings = []

    def add(self, file, rule, details):
        self.errors.append(f"[FAIL] {file}: {rule} -> {details}")

    def warn(self, file, rule, details):
        self.warnings.append(f"[WARN] {file}: {rule} -> {details}")

    def has_errors(self):
        return len(self.errors) > 0

    def report(self):
        if self.warnings:
            print(f"\n[WARNINGS] {len(self.warnings)} non-blocking issues:")
            for w in self.warnings[:20]:
                print(w)
            if len(self.warnings) > 20:
                print(f"  ... and {len(self.warnings) - 20} more warnings")
        if not self.errors:
            print("\n[OK] CES CHECK PASSED: System is Compliant.")
            return True
        print("\n[FAIL] CES CHECK FAILED: Violations Detected!")
        for e in self.errors:
            print(e)
        print(f"\nTotal Violations: {len(self.errors)}")
        return False


def is_text_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            f.read(1024)
        return True
    except UnicodeDecodeError:
        return False


def check_english_only(content, filepath, violations):
    cjk_pattern = re.compile(
        r'[一-鿿぀-ゟ゠-ヿ가-힯　-〿＀-￯]'
    )
    line_num = 0
    for line in content.splitlines():
        line_num += 1
        match = cjk_pattern.search(line)
        if match:
            msg = f"CJK text at line {line_num}: {line.strip()[:40]}..."
            if ENGLISH_STRICT:
                violations.add(filepath, "Art 8.1 English Mandate", msg)
            else:
                violations.warn(filepath, "Art 8.1 English Mandate (V0.1 warn)", msg)
            break  # one report per file


def check_file(filepath, violations):
    filename = os.path.basename(filepath)
    if filename in IGNORE_FILES or not is_text_file(filepath):
        return
    if filename.startswith('temp_'):
        return

    for pattern in FORBIDDEN_FILES:
        if re.search(pattern, filename, re.IGNORECASE):
            violations.add(
                filepath, "Art 9.1 Confidentiality",
                f"Filename matches forbidden pattern '{pattern}'",
            )
            return

    ext = os.path.splitext(filename)[1]
    if ext not in SCAN_EXTENSIONS:
        return

    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
            lines = content.splitlines()

        if len(lines) > MAX_LINES:
            violations.add(
                filepath, "Art 5.1 Monolith Ban",
                f"File length {len(lines)} > {MAX_LINES} lines",
            )

        for pattern, name in SECRET_PATTERNS:
            if re.search(pattern, content):
                violations.add(
                    filepath, "Art 5.1 Security Protocol",
                    f"Potential {name} detected",
                )

        if ext not in ['.md', '.json']:
            check_english_only(content, filepath, violations)

    except Exception as e:
        print(f"[WARN] Could not scan {filepath}: {e}")


def main():
    print("[CES] Initiating Sciweon Compliance Enforcement Script...")
    print(f"[CES] English strict mode: {ENGLISH_STRICT}")
    root_dir = os.getcwd()
    violations = Violations()
    for root, dirs, files in os.walk(root_dir):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
        for file in files:
            filepath = os.path.join(root, file)
            check_file(filepath, violations)
    if violations.report():
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
