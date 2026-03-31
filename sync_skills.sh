#!/bin/bash

# Source directory containing skills
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills"

# Target directories
TARGET_DIRS=(
    "$HOME/.config/opencode/skills"
    "$HOME/.claude/skills"
)

for TARGET_DIR in "${TARGET_DIRS[@]}"; do
    TARGET_PARENT_DIR="$(dirname "$TARGET_DIR")"

    echo "Syncing skills from $SRC_DIR to $TARGET_DIR..."

    # Ensure target parent directory exists
    mkdir -p "$TARGET_PARENT_DIR"

    # Check if target already exists
    if [ -L "$TARGET_DIR" ]; then
        echo "Removing existing symlink at $TARGET_DIR..."
        rm "$TARGET_DIR"
    elif [ -e "$TARGET_DIR" ]; then
        BACKUP_DIR="${TARGET_DIR}_backup_$(date +%Y%m%d_%H%M%S)"
        echo "Target $TARGET_DIR already exists (not a symlink). Creating backup at $BACKUP_DIR..."
        mv "$TARGET_DIR" "$BACKUP_DIR"
    fi

    # Create symlink
    echo "Creating symlink..."
    ln -s "$SRC_DIR" "$TARGET_DIR"

    if [ $? -eq 0 ]; then
        echo "✅ Successfully synced skills. Linked to $TARGET_DIR."
    else
        echo "❌ Failed to create symlink for $TARGET_DIR."
        exit 1
    fi
done
