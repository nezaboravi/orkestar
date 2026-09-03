import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const unix = fs.readFileSync(path.join(repoRoot, 'bootstrap.sh'), 'utf8').replace(/\r\n/g, '\n');
const windows = fs.readFileSync(path.join(repoRoot, 'bootstrap.ps1'), 'utf8').replace(/\r\n/g, '\n');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'portable-bootstrap.yml'), 'utf8').replace(/\r\n/g, '\n');

test('Unix bootstrap is strict and supports macOS and Linux architectures', () => {
  assert.match(unix, /^#!\/bin\/sh\nset -eu/m);
  assert.match(unix, /Darwin\) platform="darwin"/);
  assert.match(unix, /Linux\) platform="linux"/);
  assert.match(unix, /arm64\|aarch64/);
  assert.match(unix, /x86_64\|amd64/);
});

test('CI proves both Ubuntu and the Arch base used by Omarchy', () => {
  assert.match(workflow, /os: \[macos-latest, ubuntu-latest\]/);
  assert.match(workflow, /container: archlinux:latest/);
  assert.match(workflow, /pacman -Syu --noconfirm git nodejs npm curl tar openssl/);
});

test('both bootstraps verify the pinned Node archive checksum', () => {
  assert.match(unix, /SHASUMS256\.txt/);
  assert.match(unix, /Node\.js checksum did not match/);
  assert.match(windows, /SHASUMS256\.txt/);
  assert.match(windows, /Get-FileHash -Algorithm SHA256/);
});

test('bootstraps install the orchestra with Herdr as the default workspace', () => {
  for (const source of [unix, windows]) {
    assert.match(source, /herdr\.dev\/(?:install|latest)/);
    assert.match(source, /orchestra\.mjs/);
    assert.match(source, /--installed/);
    assert.match(source, /--structural/);
  }
  assert.match(unix, /if \[ "\$USE_HERDR" -eq 1 \]; then install_herdr; fi/);
  assert.match(windows, /if \(\$HerdrEnabled -and \$null -eq \(Get-Command herdr\.exe/);
  assert.match(unix, /chatgpt\.com\/codex\/install\.sh/);
  assert.match(unix, /CANDIDATES="cursor codex claude kimi opencode"/);
  assert.match(unix, /trying the next configured harness/i);
  assert.match(windows, /opencode-ai/);
});

test('one-command bootstraps recoverably back up conflicts by default', () => {
  assert.match(unix, /CONFLICT="backup"/);
  assert.match(unix, /default: backup/);
  assert.match(windows, /\[string\]\$Conflict = "backup"/);
});

test('automatic harness fallback happens only for an unavailable model route', () => {
  assert.match(unix, /case "\$install_status" in/);
  assert.match(unix, /3\)[\s\S]*trying the next configured harness/);
  assert.match(unix, /2\) fail "installation conflicts stopped setup/);
  assert.match(unix, /\*\) fail "\$candidate setup failed before model fallback/);
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

test('Unix bootstrap retains a direct CLI escape path', () => {
  assert.match(unix, /step "Opening Lenka directly in \$SELECTED_HARNESS"/);
  assert.match(unix, /exec node "\$REPO_DIR\/harness-launcher\.mjs"/);
  assert.match(unix, /runtime\/\$SELECTED_HARNESS\.json/);
  assert.match(unix, /AGENT_ORCHESTRA_PRIMARY_MODEL/);
  assert.match(unix, /AGENT_ORCHESTRA_REASONING_EFFORT/);
});

test('Herdr is the default project-scoped workspace with a direct bypass', () => {
  assert.match(unix, /session-name\.mjs/);
  assert.match(windows, /session-name\.mjs/);
  assert.match(unix, /if \[ "\$USE_HERDR" -eq 1 \]; then/);
  assert.match(windows, /if \(\$HerdrEnabled\)/);
  assert.match(unix, /USE_HERDR=1/);
  assert.match(unix, /--direct\) USE_HERDR=0/);
  assert.match(windows, /\$HerdrEnabled = -not \$Direct/);
  assert.match(unix, /herdr --session "\$session_name"/);
  assert.match(windows, /--session \$SessionName/);
  assert.doesNotMatch(unix, /herdr --session agent-orchestra/);
  assert.doesNotMatch(windows, /--session agent-orchestra/);
  assert.match(windows, /herdr-starter\.mjs/);
  assert.match(windows, /runtime\\\$SelectedHarness\.json/);
  assert.match(unix, /herdr-starter\.mjs/);
  assert.doesNotMatch(unix, /default_shell/);
  assert.doesNotMatch(windows, /default_shell/);
});

test('Windows retains a provider-neutral direct CLI escape path', () => {
  assert.match(windows, /Write-Step "Opening Lenka directly in \$SelectedHarness"/);
  assert.match(windows, /harness-launcher\.mjs/);
});

test('Unix bootstrap does not modify shell startup files', () => {
  assert.doesNotMatch(unix, /\.zshrc|\.bashrc|profile/);
});

test('Unix bootstrap probes authenticated routes once and then checks structural invariants', () => {
  assert.match(unix, /if \[ "\$STRUCTURAL_ONLY" -eq 1 \]; then\n  step "Verifying the installed team structurally"/);
  assert.match(unix, /else\n  step "Checking source and permission invariants"\n  set -- doctor --home "\$TARGET_HOME" --structural --tool "\$SELECTED_HARNESS"/);
  assert.doesNotMatch(unix, /doctor --home "\$TARGET_HOME" --installed --tool "\$SELECTED_HARNESS"/);
});

test('bootstraps request compact install output', () => {
  assert.match(unix, /--tool "\$candidate" --quiet/);
  assert.match(windows, /"--conflict", \$Conflict, "--quiet"/);
});
