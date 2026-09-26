#!/bin/bash
# Installs claude-elytron on Linux or macOS.
#   curl -fsSL https://api.elytrondefense.com/install/setup.sh | bash
# Optional: pass another server as the first argument (bash -s -- <url>).
set -euo pipefail

URL="${1:-https://api.elytrondefense.com}"
URL="${URL%/}"
BIN="$HOME/.local/bin"

echo "== claude-elytron installer =="
echo "server:  $URL"
echo "install: $BIN/claude-elytron"

if ! command -v claude >/dev/null 2>&1; then
    echo "Claude Code is not installed; installing it first..."
    curl -fsSL https://claude.ai/install.sh | bash
fi

mkdir -p "$BIN"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$URL/install/claude-elytron" -o "$tmp"
bash -n "$tmp" || { echo "The downloaded script is broken; nothing was installed." >&2; exit 1; }
install -m 755 "$tmp" "$BIN/claude-elytron"

# Only a non-default server needs writing down; an existing config is kept as it is.
config="${XDG_CONFIG_HOME:-$HOME/.config}/claude-elytron/env"
if [ ! -f "$config" ] && [ "$URL" != "https://api.elytrondefense.com" ]; then
    mkdir -p "$(dirname "$config")"
    ( umask 077; echo "CLAUDE_ELYTRON_URL=$URL" > "$config" )
fi

case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
        for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
            [ -f "$rc" ] || continue
            grep -q '\.local/bin' "$rc" || printf '\n# Added by the claude-elytron installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
        done
        echo "Added ~/.local/bin to your PATH; open a new shell or run: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

echo ""
echo "Installed $("$BIN/claude-elytron" --version)."
echo "Next:"
echo "  claude-elytron --login   # sign in with your browser"
echo "  claude-elytron           # start Claude Code"
