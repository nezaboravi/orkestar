import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const unix = fs.readFileSync(path.join(repoRoot, 'bootstrap.sh'), 'utf8').replace(/\r\n/g, '\n');
const windows = fs.readFileSync(path.join(repoRoot, 'bootstrap.ps1'), 'utf8').replace(/\r\n/g, '\n');

test('Unix bootstrap is strict and supports macOS and Linux architectures', () => {
  assert.match(unix, /^#!\/bin\/sh\nset -eu/m);
  assert.match(unix, /Darwin\) platform="darwin"/);
  assert.match(unix, /Linux\) platform="linux"/);
  assert.match(unix, /arm64\|aarch64/);
  assert.match(unix, /x86_64\|amd64/);
});

test('both bootstraps verify the pinned Node archive checksum', () => {
  assert.match(unix, /SHASUMS256\.txt/);
  assert.match(unix, /Node\.js checksum did not match/);
  assert.match(windows, /SHASUMS256\.txt/);
  assert.match(windows, /Get-FileHash -Algorithm SHA256/);
});

test('bootstraps install the orchestra while keeping Herdr optional', () => {
  for (const source of [unix, windows]) {
    assert.match(source, /herdr\.dev\/(?:install|latest)/);
    assert.match(source, /orchestra\.mjs/);
    assert.match(source, /--installed/);
    assert.match(source, /--structural/);
  }
  assert.match(unix, /if \[ "\$USE_HERDR" -eq 1 \]; then install_herdr; fi/);
  assert.match(windows, /if \(\$UseHerdr -and \$null -eq \(Get-Command herdr\.exe/);
  assert.match(unix, /chatgpt\.com\/codex\/install\.sh/);
  assert.match(unix, /CANDIDATES="codex claude kimi opencode"/);
  assert.match(unix, /trying the next configured harness/i);
  assert.match(windows, /opencode-ai/);
});

test('both bootstraps install Lenka from a package archive instead of linking the checkout', () => {
  for (const source of [unix, windows]) {
    assert.match(source, /npm(?:\.cmd)? pack --silent --pack-destination/);
    assert.match(source, /npm(?:\.cmd)? install --global --prefix/);
    assert.match(source, /standalone package, not a repository (?:symlink|link)/);
  }
  assert.doesNotMatch(unix, /npm install --global --prefix "\$TARGET_HOME\/\.local" "\$REPO_DIR"/);
  assert.doesNotMatch(windows, /npm\.cmd install --global --prefix \(Join-Path \$TargetHome "\.local"\) \$RepoDir/);
});

test('Unix bootstrap launches the selected CLI directly by default', () => {
  assert.match(unix, /step "Opening Lenka directly in \$SELECTED_HARNESS"/);
  assert.match(unix, /exec node "\$REPO_DIR\/harness-launcher\.mjs"/);
  assert.match(unix, /runtime\/\$SELECTED_HARNESS\.json/);
  assert.match(unix, /AGENT_ORCHESTRA_PRIMARY_MODEL/);
  assert.match(unix, /AGENT_ORCHESTRA_REASONING_EFFORT/);
});

test('Herdr remains an explicit project-scoped option', () => {
  assert.match(unix, /session-name\.mjs/);
  assert.match(windows, /session-name\.mjs/);
  assert.match(unix, /if \[ "\$USE_HERDR" -eq 1 \]; then/);
  assert.match(windows, /if \(\$UseHerdr\)/);
  assert.match(unix, /herdr --session "\$session_name"/);
  assert.match(windows, /--session \$SessionName/);
  assert.doesNotMatch(unix, /herdr --session agent-orchestra/);
  assert.doesNotMatch(windows, /--session agent-orchestra/);
  assert.match(windows, /default_agent = "lenka"; model = \$OpenCodePrimaryModel/);
  assert.match(windows, /runtime\\opencode\.json/);
  assert.match(unix, /harness-launcher\.mjs/);
  assert.match(unix, /default_shell/);
  assert.match(windows, /default_shell/);
});

test('Windows launches Lenka directly in OpenCode unless Herdr is requested', () => {
  assert.match(windows, /Write-Step "Opening Lenka directly in OpenCode"/);
  assert.match(windows, /harness-launcher\.mjs/);
});

test('Unix bootstrap does not modify shell startup files', () => {
  assert.doesNotMatch(unix, /\.zshrc|\.bashrc|profile/);
});

test('Unix bootstrap verifies installed live routes with the same authenticated policy', () => {
  assert.match(unix, /if \[ "\$STRUCTURAL_ONLY" -eq 1 \]; then\n  step "Verifying the installed team structurally"/);
  assert.match(unix, /else\n  step "Verifying the installed team with authenticated model routes"\n  set -- doctor --home "\$TARGET_HOME" --installed --tool "\$SELECTED_HARNESS"/);
});
