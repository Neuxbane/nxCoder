#!/usr/bin/env bash
# ==============================================================================
# nxCoder Unified Multi-Platform Release Builder
# Builds:
#   1. App    - GUI Desktop (Linux, Windows) & Mobile (Android)
#   2. Server - Headless Go Backend Engines (Linux, macOS, Windows — AMD64 & ARM64)
# ==============================================================================

set -e

# ANSI Color Codes
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m' # No Color

OUTPUT_DIR="$(pwd)/release-builds"
mkdir -p "$OUTPUT_DIR"

# ------------------------------------------------------------------------------
# Environment Setup & Auto-Detection
# ------------------------------------------------------------------------------
setup_env() {
    # Java JDK Detection
    if [ -z "$JAVA_HOME" ] || [ ! -d "$JAVA_HOME" ]; then
        if [ -d "/usr/lib/jvm/java-21-openjdk" ]; then
            export JAVA_HOME="/usr/lib/jvm/java-21-openjdk"
        elif [ -d "/usr/lib/jvm/java-17-openjdk" ]; then
            export JAVA_HOME="/usr/lib/jvm/java-17-openjdk"
        elif [ -d "/usr/lib/jvm/default" ]; then
            export JAVA_HOME="/usr/lib/jvm/default"
        fi
    fi

    # Android SDK Detection
    if [ -z "$ANDROID_HOME" ] || [ ! -d "$ANDROID_HOME" ]; then
        if [ -d "$HOME/Android/Sdk" ]; then
            export ANDROID_HOME="$HOME/Android/Sdk"
        fi
    fi

    # Android NDK Detection
    if [ -n "$ANDROID_HOME" ] && [ -d "$ANDROID_HOME/ndk" ]; then
        LATEST_NDK=$(command ls -1 "$ANDROID_HOME/ndk" 2>/dev/null | tail -n 1)
        if [ -n "$LATEST_NDK" ]; then
            export NDK_HOME="$ANDROID_HOME/ndk/$LATEST_NDK"
        fi
    fi

    # Add Tools to PATH
    if [ -n "$ANDROID_HOME" ]; then
        export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"
    fi

    # AppImage & LinuxDeploy compatibility (for distros without FUSE 2 / containers)
    export APPIMAGE_EXTRACT_AND_RUN=1
    export NO_STRIP=true
}

# ------------------------------------------------------------------------------
# Build Headless Server Engines (Go Backend — Linux, macOS, Windows AMD64/ARM64)
# ------------------------------------------------------------------------------
build_server_backends() {
    echo -e "\n${CYAN}${BOLD}[*] Building Headless Server Engines (Linux, macOS, Windows — AMD64 & ARM64)...${NC}"
    if ! command -v go >/dev/null 2>&1; then
        echo -e "${RED}✘ Go compiler not found.${NC}"
        return 1
    fi

    GO_DIR="backend"
    GO_MAIN="./cmd/server/main.go"
    SERVER_PREFIX="nxCoder-server"

    if [ ! -d "$GO_DIR" ]; then
        echo -e "${RED}✘ Backend directory '$GO_DIR' not found.${NC}"
        return 1
    fi

    pushd "$GO_DIR" >/dev/null
    go mod tidy

    # Linux Server (x86_64 & ARM64)
    echo -e "${YELLOW}Compiling Server: Linux AMD64 & ARM64...${NC}"
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/${SERVER_PREFIX}-linux-amd64" "$GO_MAIN"
    CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/${SERVER_PREFIX}-linux-arm64" "$GO_MAIN"

    # macOS Server (Apple Silicon & Intel)
    echo -e "${YELLOW}Compiling Server: macOS AMD64 & ARM64...${NC}"
    CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/${SERVER_PREFIX}-macos-amd64" "$GO_MAIN"
    CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/${SERVER_PREFIX}-macos-arm64" "$GO_MAIN"

    # Windows Server (x86_64 & ARM64)
    echo -e "${YELLOW}Compiling Server: Windows AMD64 & ARM64...${NC}"
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/${SERVER_PREFIX}-windows-amd64.exe" "$GO_MAIN"
    CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/${SERVER_PREFIX}-windows-arm64.exe" "$GO_MAIN"

    popd >/dev/null
    echo -e "${GREEN}✔ Server headless binaries built in:${NC} $OUTPUT_DIR/"
}

# ------------------------------------------------------------------------------
# 2. Build Desktop (Linux, macOS, Windows — AMD64 & ARM64)
# ------------------------------------------------------------------------------
build_desktop() {
    echo -e "\n${CYAN}${BOLD}=== Building Desktop Apps & Headless Server Engines ===${NC}"
    
    # 1. Build Headless Go Server Engines
    build_server_backends

    # 2. Build Frontend & Tauri Linux Desktop App
    echo -e "\n${CYAN}${BOLD}[*] Building Tauri Desktop GUI Application...${NC}"
    npm run build

    # Build Linux Release (Tauri / Cargo)
    if [ "$(uname)" = "Linux" ]; then
        echo -e "${YELLOW}Building Linux Desktop GUI packages (.AppImage, .deb, .rpm, binary)...${NC}"
        npm run tauri build || {
            echo -e "${YELLOW}Tauri package builder completed with notice. Verifying generated artifacts...${NC}"
        }

        # Standalone binary fallback if not built
        if [ ! -f "src-tauri/target/release/nxcoder" ]; then
            cargo build --release --manifest-path src-tauri/Cargo.toml
        fi

        # Copy standalone Linux binary without version number
        if [ -f "src-tauri/target/release/nxcoder" ]; then
            rm -f "$OUTPUT_DIR/nxCoder-app-linux-amd64"
            cp --remove-destination -f "src-tauri/target/release/nxcoder" "$OUTPUT_DIR/nxCoder-app-linux-amd64"
            echo -e "${GREEN}✔ Linux GUI binary copied:${NC} $OUTPUT_DIR/nxCoder-app-linux-amd64"
        fi

        # Copy Debian, RedHat, and AppImage bundles with clean names
        if [ -d "src-tauri/target/release/bundle" ]; then
            find src-tauri/target/release/bundle/deb -name "*.deb" -exec cp --remove-destination -f {} "$OUTPUT_DIR/nxCoder-app-linux-amd64.deb" \; 2>/dev/null || true
            find src-tauri/target/release/bundle/rpm -name "*.rpm" -exec cp --remove-destination -f {} "$OUTPUT_DIR/nxCoder-app-linux-amd64.rpm" \; 2>/dev/null || true
            find src-tauri/target/release/bundle/appimage -name "*.AppImage" -exec cp --remove-destination -f {} "$OUTPUT_DIR/nxCoder-app-linux-amd64.AppImage" \; 2>/dev/null || true
            echo -e "${GREEN}✔ Linux Desktop GUI packages copied to:${NC} $OUTPUT_DIR/"
        fi
    fi

    # Cross-compile Windows Desktop GUI (.exe)
    if command -v rustup >/dev/null 2>&1; then
        echo -e "\n${CYAN}${BOLD}[*] Checking Windows Desktop GUI target (x86_64-pc-windows-gnu)...${NC}"
        if ! rustup target list | grep -q "x86_64-pc-windows-gnu (installed)"; then
            echo -e "${YELLOW}Adding Rust target 'x86_64-pc-windows-gnu'...${NC}"
            rustup target add x86_64-pc-windows-gnu 2>/dev/null || true
        fi

        if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || command -v mingw64-gcc >/dev/null 2>&1; then
            echo -e "${YELLOW}Cross-compiling Windows Desktop GUI (.exe)...${NC}"
            cargo build --release --target x86_64-pc-windows-gnu --manifest-path src-tauri/Cargo.toml || {
                echo -e "${YELLOW}Notice: Windows GUI cross-compilation could not complete.${NC}"
            }
            if [ -f "src-tauri/target/x86_64-pc-windows-gnu/release/nxcoder.exe" ]; then
                rm -f "$OUTPUT_DIR/nxCoder-app-windows-amd64.exe"
                cp --remove-destination -f "src-tauri/target/x86_64-pc-windows-gnu/release/nxcoder.exe" "$OUTPUT_DIR/nxCoder-app-windows-amd64.exe"
                echo -e "${GREEN}✔ Windows Desktop GUI App built:${NC} $OUTPUT_DIR/nxCoder-app-windows-amd64.exe"
            fi
        else
            echo -e "${YELLOW}MinGW-w64 GCC linker (x86_64-w64-mingw32-gcc) not found on system.${NC}"
            echo -e "To compile the Windows GUI App on Linux, install: ${BOLD}sudo pacman -S mingw-w64-gcc${NC} (Arch) or ${BOLD}sudo apt install mingw-w64${NC} (Ubuntu/Debian)"
        fi

        # Cross-compile Linux ARM64 GUI if target is available
        if rustup target list | grep -q "aarch64-unknown-linux-gnu (installed)"; then
            echo -e "\n${YELLOW}Cross-compiling Linux ARM64 Desktop GUI binary...${NC}"
            cargo build --release --target aarch64-unknown-linux-gnu --manifest-path src-tauri/Cargo.toml 2>/dev/null || true
            if [ -f "src-tauri/target/aarch64-unknown-linux-gnu/release/nxcoder" ]; then
                rm -f "$OUTPUT_DIR/nxCoder-app-linux-arm64"
                cp --remove-destination -f "src-tauri/target/aarch64-unknown-linux-gnu/release/nxcoder" "$OUTPUT_DIR/nxCoder-app-linux-arm64"
                echo -e "${GREEN}✔ Linux ARM64 Desktop GUI binary built:${NC} $OUTPUT_DIR/nxCoder-app-linux-arm64"
            fi
        fi
    fi

    echo -e "\n${GREEN}${BOLD}✔ Desktop build stage complete.${NC}"
}

# ------------------------------------------------------------------------------
# 3. Build Mobile (Android APK)
# ------------------------------------------------------------------------------
build_mobile() {
    echo -e "\n${CYAN}${BOLD}=== Building Mobile Release (Android APK) ===${NC}"
    setup_env

    if [ -z "$ANDROID_HOME" ]; then
        echo -e "${RED}✘ Android SDK not found. Please set ANDROID_HOME or install Android Studio / SDK command-line tools.${NC}"
        return 1
    fi

    # Initialize Android Studio project if not yet initialized
    if [ ! -d "src-tauri/gen/android" ]; then
        echo -e "${YELLOW}Android project not initialized. Initializing Tauri Android...${NC}"
        npm run tauri android init
    fi

    # Ensure self-signed release keystore exists
    if [ ! -f "release.keystore" ]; then
        echo -e "${YELLOW}Creating self-signed release keystore (release.keystore)...${NC}"
        keytool -genkey -v -keystore release.keystore -alias nxcoder -keyalg RSA -keysize 2048 -validity 10000 \
            -storepass password123 -keypass password123 -dname "CN=nxCoder, OU=Dev, O=nxCoder, L=Local, ST=State, C=US"
    fi

    echo -e "${YELLOW}Building release APK with Tauri v2...${NC}"
    npm run tauri android build -- --apk

    # Locate generated APKs
    UNSIGNED_APK=$(find src-tauri/gen/android/app/build/outputs/apk -name "*release-unsigned.apk" 2>/dev/null | head -n 1)
    SIGNED_DEFAULT_APK=$(find src-tauri/gen/android/app/build/outputs/apk -name "*release.apk" ! -name "*unsigned*" 2>/dev/null | head -n 1)

    # Locate apksigner
    APKSIGNER_BIN=$(find "$ANDROID_HOME/build-tools" -name "apksigner" 2>/dev/null | sort -V | tail -n 1)
    if [ -z "$APKSIGNER_BIN" ]; then
        APKSIGNER_BIN="apksigner"
    fi

    if [ -n "$UNSIGNED_APK" ]; then
        echo -e "${YELLOW}Signing APK with release.keystore...${NC}"
        rm -f "$OUTPUT_DIR/nxCoder-app-android.apk"
        "$APKSIGNER_BIN" sign --ks release.keystore --ks-pass pass:password123 --out "$OUTPUT_DIR/nxCoder-app-android.apk" "$UNSIGNED_APK"
        echo -e "${GREEN}✔ Signed Release APK built:${NC} $OUTPUT_DIR/nxCoder-app-android.apk"
    elif [ -n "$SIGNED_DEFAULT_APK" ]; then
        rm -f "$OUTPUT_DIR/nxCoder-app-android.apk"
        cp --remove-destination -f "$SIGNED_DEFAULT_APK" "$OUTPUT_DIR/nxCoder-app-android.apk"
        echo -e "${GREEN}✔ Release APK copied:${NC} $OUTPUT_DIR/nxCoder-app-android.apk"
    else
        echo -e "${RED}✘ Release APK not found in src-tauri/gen/android/app/build/outputs/apk${NC}"
        return 1
    fi

    command ls -lh "$OUTPUT_DIR"/nxCoder-app-android*.apk 2>/dev/null || true
}

# ------------------------------------------------------------------------------
# 1. Build ALL Targets
# ------------------------------------------------------------------------------
build_all() {
    echo -e "\n${BOLD}${CYAN}=== Building ALL Targets (Desktop + Mobile) ===${NC}"
    build_desktop
    build_mobile
}

# ------------------------------------------------------------------------------
# Main Interactive CLI Menu
# ------------------------------------------------------------------------------
show_menu() {
    clear
    setup_env
    echo -e "${CYAN}${BOLD}"
    echo "========================================================="
    echo "            nxCoder Unified Release Builder              "
    echo "========================================================="
    echo -e "${NC}"
    echo -e " Output Folder: ${YELLOW}$OUTPUT_DIR${NC}\n"
    echo -e "  ${BOLD}[1]${NC} ${GREEN}${BOLD}Build ALL Targets (Desktop + Mobile)${NC}"
    echo -e "  ${BOLD}[2]${NC} Build Desktop (Linux, macOS, Windows — AMD64 & ARM64)"
    echo -e "  ${BOLD}[3]${NC} Build Mobile (Android APK)"
    echo -e "  ${BOLD}[0]${NC} Exit"
    echo ""
    read -p "Select an option [0-3] and press Enter: " choice

    case "$choice" in
        1)
            build_all
            ;;
        2)
            build_desktop
            ;;
        3)
            build_mobile
            ;;
        0)
            echo -e "\n${YELLOW}Exiting.${NC}"
            exit 0
            ;;
        *)
            echo -e "\n${RED}Invalid option.${NC}"
            exit 1
            ;;
    esac

    echo -e "\n${GREEN}${BOLD}=========================================================${NC}"
    echo -e "${GREEN}${BOLD}                 Build Process Complete!                 ${NC}"
    echo -e "${GREEN}${BOLD}=========================================================${NC}"
    echo -e "All generated binaries are located in:\n${CYAN}$OUTPUT_DIR${NC}\n"
    command ls -lh "$OUTPUT_DIR"
}

# Run Menu
show_menu
