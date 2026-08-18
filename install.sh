#!/usr/bin/env bash

set -e

OWNER="tetttet"
REPO="hcode"

INSTALL_DIR="$HOME/.local/bin"
INSTALL_PATH="$INSTALL_DIR/hcode"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    OS_NAME="darwin"
    ;;
  Linux)
    OS_NAME="linux"
    ;;
  *)
    echo "Unsupported operating system: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64)
    ARCH_NAME="arm64"
    ;;
  x86_64|amd64)
    ARCH_NAME="x64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

BINARY="hcode-${OS_NAME}-${ARCH_NAME}"

URL="https://github.com/${OWNER}/${REPO}/releases/latest/download/${BINARY}"

echo "Installing hcode..."
echo "Platform: ${OS_NAME}-${ARCH_NAME}"

mkdir -p "$INSTALL_DIR"

curl -fL "$URL" -o "$INSTALL_PATH"

chmod +x "$INSTALL_PATH"

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    ;;
  *)
    SHELL_NAME="$(basename "$SHELL")"

    if [ "$SHELL_NAME" = "zsh" ]; then
      SHELL_CONFIG="$HOME/.zshrc"
    else
      SHELL_CONFIG="$HOME/.bashrc"
    fi

    PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

    if ! grep -Fq "$PATH_LINE" "$SHELL_CONFIG" 2>/dev/null; then
      echo "" >> "$SHELL_CONFIG"
      echo "$PATH_LINE" >> "$SHELL_CONFIG"
    fi

    export PATH="$INSTALL_DIR:$PATH"

    echo ""
    echo "Added ~/.local/bin to PATH."
    echo "Restart your terminal or run:"
    echo ""
    echo "  source $SHELL_CONFIG"
    ;;
esac

echo ""
echo "✓ hcode installed successfully"
echo ""
echo "Run:"
echo ""
echo "  hcode"
echo ""
