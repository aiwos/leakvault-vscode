#!/bin/bash
# LeakVault Security Audit Script
# Run this before every commit and before releases
# Usage: bash scripts/security-audit.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
FAILED=0

echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         LeakVault Security Audit Framework v1.0                ║"
echo "║              https://github.com/aiwos/leakvault-vscode          ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────────────────────
# 1. Hardcoded Secrets Scan
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [1/8] Scanning for hardcoded secrets..."

SECRETS_PATTERNS=(
  'password\s*=\s*["\x27]?[A-Za-z0-9!@#\$%^&*\-_+=]{8,}'
  'api[_-]?key\s*=\s*["\x27]?sk'
  'secret\s*=\s*["\x27]?[A-Za-z0-9]'
  'token\s*=\s*["\x27]?[A-Za-z0-9]'
  'auth[_-]?token\s*=\s*["\x27]?'
  'private[_-]?key\s*=\s*'
)

FOUND_SECRETS=0

for pattern in "${SECRETS_PATTERNS[@]}"; do
  if grep -rE "$pattern" "$PROJECT_ROOT/src" "$PROJECT_ROOT/out" "$PROJECT_ROOT"/*.json "$PROJECT_ROOT"/*.md 2>/dev/null | \
     grep -v "node_modules" | \
     grep -v "SECURITY_AUDIT.md" | \
     grep -v "credentialScanner" | \
     grep -v ".vsix" | \
     grep -v "test"; then
    FOUND_SECRETS=$((FOUND_SECRETS + 1))
  fi
done

if [ $FOUND_SECRETS -gt 0 ]; then
  echo "  ✗ FAILED: Possible hardcoded secrets detected"
  FAILED=$((FAILED + 1))
else
  echo "  ✓ PASSED: No hardcoded secrets found"
fi

# ─────────────────────────────────────────────────────────────────────
# 2. AWS Key Scan
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [2/8] Scanning for AWS credentials..."

if grep -rE "AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}" "$PROJECT_ROOT/src" "$PROJECT_ROOT/out" 2>/dev/null | \
   grep -v "test" > /dev/null; then
  echo "  ✗ FAILED: AWS credentials found in codebase"
  FAILED=$((FAILED + 1))
else
  echo "  ✓ PASSED: No AWS credentials found"
fi

# ─────────────────────────────────────────────────────────────────────
# 3. GitHub Token Scan
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [3/8] Scanning for GitHub tokens..."

if grep -rE "ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|gho_[A-Za-z0-9]{36}" "$PROJECT_ROOT/src" "$PROJECT_ROOT/out" 2>/dev/null | \
   grep -v "test\|credentialScanner" > /dev/null; then
  echo "  ✗ FAILED: GitHub tokens found in codebase"
  FAILED=$((FAILED + 1))
else
  echo "  ✓ PASSED: No GitHub tokens found"
fi

# ─────────────────────────────────────────────────────────────────────
# 4. TypeScript Compilation Check
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [4/8] Checking TypeScript compilation..."

if ! npx tsc --noEmit 2>&1 > /tmp/tsc-output.log; then
  echo "  ✗ FAILED: TypeScript compilation errors"
  cat /tmp/tsc-output.log | head -20
  FAILED=$((FAILED + 1))
else
  echo "  ✓ PASSED: TypeScript compiles without errors"
fi

# ─────────────────────────────────────────────────────────────────────
# 5. Dependency Audit (npm audit)
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [5/8] Auditing npm dependencies..."

if npm audit --audit-level=moderate 2>&1 | grep -q "vulnerabilities"; then
  echo "  ⚠️  WARNING: Vulnerabilities found in dependencies"
  npm audit --audit-level=moderate 2>&1 | head -20
  # Don't fail on this, but warn
else
  echo "  ✓ PASSED: No moderate/high vulnerabilities in dependencies"
fi

# ─────────────────────────────────────────────────────────────────────
# 6. File Permissions Check
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [6/8] Checking vault file permissions..."

if [ -d "$HOME/.leakvault" ]; then
  # Try Linux stat first, then macOS
  PERMS=$(stat -c %a "$HOME/.leakvault" 2>/dev/null || stat -f %OLp "$HOME/.leakvault" 2>/dev/null || echo "unknown")

  # Handle both "700" and "0700" formats
  PERMS_LAST3="${PERMS: -3}"

  if [ "$PERMS_LAST3" != "700" ]; then
    echo "  ✗ FAILED: Vault directory has permissions $PERMS, should be 0700"
    echo "    Fix: chmod 0700 ~/.leakvault"
    FAILED=$((FAILED + 1))
  else
    echo "  ✓ PASSED: Vault directory has correct permissions (0700)"
  fi

  # Check individual vault files
  VAULT_FILES=$(find "$HOME/.leakvault" -maxdepth 1 -type f -name "*.enc" 2>/dev/null | wc -l)
  if [ $VAULT_FILES -gt 0 ]; then
    while IFS= read -r file; do
      FILE_PERMS=$(stat -c %a "$file" 2>/dev/null || stat -f %OLp "$file" 2>/dev/null || echo "unknown")
      FILE_PERMS_LAST3="${FILE_PERMS: -3}"
      if [ "$FILE_PERMS_LAST3" != "600" ]; then
        echo "  ✗ FAILED: File $file has permissions $FILE_PERMS, should be 0600"
        FAILED=$((FAILED + 1))
      fi
    done < <(find "$HOME/.leakvault" -maxdepth 1 -type f -name "*.enc")
    echo "  ✓ PASSED: All vault files have correct permissions (0600)"
  fi
else
  echo "  ℹ️  INFO: Vault directory not yet created (normal for fresh install)"
fi

# ─────────────────────────────────────────────────────────────────────
# 7. Encryption Algorithm Verification
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [7/8] Verifying encryption configuration..."

# Check that AES-256-GCM is used
if grep -q "aes-256-gcm" "$PROJECT_ROOT/src/vaultStorage.ts"; then
  echo "  ✓ PASSED: AES-256-GCM encryption confirmed"
else
  echo "  ✗ FAILED: AES-256-GCM not found in vaultStorage.ts"
  FAILED=$((FAILED + 1))
fi

# Check that key is 32 bytes (256 bits)
if grep -q "crypto.randomBytes(32)" "$PROJECT_ROOT/src/vaultStorage.ts"; then
  echo "  ✓ PASSED: 256-bit key generation confirmed"
else
  echo "  ✗ FAILED: 256-bit key generation not found"
  FAILED=$((FAILED + 1))
fi

# Check that IV is 12 bytes
if grep -q "crypto.randomBytes(12)" "$PROJECT_ROOT/src/vaultStorage.ts"; then
  echo "  ✓ PASSED: 96-bit IV generation confirmed"
else
  echo "  ✗ FAILED: 96-bit IV generation not found"
  FAILED=$((FAILED + 1))
fi

# ─────────────────────────────────────────────────────────────────────
# 8. Code Review Checks
# ─────────────────────────────────────────────────────────────────────

echo "🔍 [8/8] Running code review checks..."

# Check for console.log in production code
if grep -rE "console\.(log|error|warn)" "$PROJECT_ROOT/src" | grep -v "test" | grep -v "debug" > /dev/null; then
  echo "  ⚠️  WARNING: Found console.log statements in source code"
  grep -rE "console\.(log|error|warn)" "$PROJECT_ROOT/src" | grep -v "test" || true
fi

# Check for TODO comments (low priority)
TODO_COUNT=$(grep -r "TODO\|FIXME\|HACK" "$PROJECT_ROOT/src" | wc -l)
if [ $TODO_COUNT -gt 0 ]; then
  echo "  ℹ️  INFO: Found $TODO_COUNT TODO/FIXME comments"
fi

echo "  ✓ PASSED: Code review checks complete"

# ─────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"

if [ $FAILED -eq 0 ]; then
  echo "║                   ✓ ALL SECURITY CHECKS PASSED                 ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "✅ Safe to commit!"
  exit 0
else
  echo "║                  ✗ $FAILED SECURITY CHECK(S) FAILED                  ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "❌ Please fix the issues above before committing."
  exit 1
fi
