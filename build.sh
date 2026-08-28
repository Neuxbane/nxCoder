#!/usr/bin/env bash
# ==============================================================================
# nxInterComm Unified Multi-Platform Release Builder
# Builds Linux, Android APK (Self-Signed), Windows EXE, and Go CLI Node Binaries
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
}

# ------------------------------------------------------------------------------
# 1. Build Linux Release
# ------------------------------------------------------------------------------
build_linux() {
    echo -e "\n${CYAN}${BOLD}[1/4] Building Linux Desktop Release...${NC}"
    npm run build
    npm run tauri build -- --no-bundle || cargo build --release --manifest-path src-tauri/Cargo.toml

    # Copy binary to release directory
    if [ -f "src-tauri/target/release/inter-comm" ]; then
        cp "src-tauri/target/release/inter-comm" "$OUTPUT_DIR/nxInterComm-linux-x86_64"
        echo -e "${GREEN}✔ Linux binary built:${NC} $OUTPUT_DIR/nxInterComm-linux-x86_64"
    fi

    # Copy bundles if generated
    if [ -d "src-tauri/target/release/bundle" ]; then
        find src-tauri/target/release/bundle -type f \( -name "*.AppImage" -o -name "*.deb" \) -exec cp {} "$OUTPUT_DIR/" \;
        echo -e "${GREEN}✔ Linux bundles copied to:${NC} $OUTPUT_DIR/"
    fi
}

# ------------------------------------------------------------------------------
# 2. Build Android Self-Signed Release APK
# ------------------------------------------------------------------------------
build_android() {
    echo -e "\n${CYAN}${BOLD}[2/4] Building Android Release APK...${NC}"
    setup_env

    if [ -z "$ANDROID_HOME" ] || [ -z "$NDK_HOME" ]; then
        echo -e "${RED}✘ Android SDK or NDK not found. Please verify ANDROID_HOME and NDK_HOME.${NC}"
        return 1
    fi

    # Ensure self-signed keystore exists
    if [ ! -f "release.keystore" ]; then
        echo -e "${YELLOW}Creating self-signed release keystore (release.keystore)...${NC}"
        keytool -genkey -v -keystore release.keystore -alias nxintercomm -keyalg RSA -keysize 2048 -validity 10000 \
            -storepass password123 -keypass password123 -dname "CN=nxInterComm, OU=Dev, O=nxInterComm, L=Local, ST=State, C=US"
    fi

    echo -e "${YELLOW}Building optimized APK with Tauri v2...${NC}"
    npm run tauri android build -- --apk

    # Locate unsigned release APK
    UNSIGNED_APK=$(find src-tauri/gen/android/app/build/outputs/apk -name "*release-unsigned.apk" | head -n 1)
    if [ -z "$UNSIGNED_APK" ]; then
        echo -e "${RED}✘ Unsigned APK not found.${NC}"
        return 1
    fi

    # Locate apksigner
    APKSIGNER_BIN=$(find "$ANDROID_HOME/build-tools" -name "apksigner" | sort -V | tail -n 1)
    if [ -z "$APKSIGNER_BIN" ]; then
        APKSIGNER_BIN="apksigner"
    fi

    echo -e "${YELLOW}Signing APK with release.keystore...${NC}"
    "$APKSIGNER_BIN" sign --ks release.keystore --ks-pass pass:password123 --out "$OUTPUT_DIR/nxInterComm-android-release.apk" "$UNSIGNED_APK"

    echo -e "${GREEN}✔ Signed Release APK built:${NC} $OUTPUT_DIR/nxInterComm-android-release.apk"
    command ls -lh "$OUTPUT_DIR/nxInterComm-android-release.apk"
}

# ------------------------------------------------------------------------------
# 3. Build Windows Executable (.exe)
# ------------------------------------------------------------------------------
build_windows() {
    echo -e "\n${CYAN}${BOLD}[3/4] Building Windows Release Executable...${NC}"
    
    if rustup target list | grep -q "x86_64-pc-windows-gnu (installed)"; then
        echo -e "${YELLOW}Compiling with x86_64-pc-windows-gnu target...${NC}"
        npm run build
        cargo build --release --target x86_64-pc-windows-gnu --manifest-path src-tauri/Cargo.toml
        
        if [ -f "src-tauri/target/x86_64-pc-windows-gnu/release/inter-comm.exe" ]; then
            cp "src-tauri/target/x86_64-pc-windows-gnu/release/inter-comm.exe" "$OUTPUT_DIR/nxInterComm-windows-x64.exe"
            echo -e "${GREEN}✔ Windows EXE built:${NC} $OUTPUT_DIR/nxInterComm-windows-x64.exe"
        fi
    else
        echo -e "${YELLOW}Target 'x86_64-pc-windows-gnu' not installed.${NC}"
        echo -e "To enable Windows cross-compiling, run: ${BOLD}rustup target add x86_64-pc-windows-gnu${NC} and install ${BOLD}mingw-w64-gcc${NC}"
    fi
}

# ------------------------------------------------------------------------------
# 4. Build Go Headless CLI Node Daemons (Linux / Windows / macOS)
# ------------------------------------------------------------------------------
build_go_nodes() {
    echo -e "\n${CYAN}${BOLD}[4/4] Building Go CLI Headless Mesh Daemons...${NC}"
    
    if command -v go >/dev/null 2>&1; then
        pushd node >/dev/null
        # Linux Binary
        CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/nxintercomm-node-linux-amd64" ./cmd/node/main.go
        # Linux ARM64 Binary (Raspberry Pi / Servers)
        CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/nxintercomm-node-linux-arm64" ./cmd/node/main.go
        # Windows EXE Binary
        CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/nxintercomm-node-windows-amd64.exe" ./cmd/node/main.go
        # macOS Darwin Binary
        CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o "$OUTPUT_DIR/nxintercomm-node-macos-arm64" ./cmd/node/main.go
        popd >/dev/null
        
        echo -e "${GREEN}✔ Go CLI Daemons built for Linux, Windows, & macOS in:${NC} $OUTPUT_DIR/"
    else
        echo -e "${RED}✘ Go compiler not found.${NC}"
    fi
}

# ------------------------------------------------------------------------------
# Build ALL Targets
# ------------------------------------------------------------------------------
build_all() {
    echo -e "\n${BOLD}${CYAN}=== Building ALL Release Targets ===${NC}"
    build_linux
    build_android
    build_windows
    build_go_nodes
}

# ------------------------------------------------------------------------------
# Main Interactive CLI Menu
# ------------------------------------------------------------------------------
show_menu() {
    clear
    setup_env
    echo -e "${CYAN}${BOLD}"
    echo "========================================================="
    echo "         nxInterComm Unified Release Builder             "
    echo "========================================================="
    echo -e "${NC}"
    echo -e " Output Folder: ${YELLOW}$OUTPUT_DIR${NC}\n"
    echo -e "  ${BOLD}[1]${NC} Build Linux Desktop App (.AppImage / .deb / binary)"
    echo -e "  ${BOLD}[2]${NC} Build Android APK (Optimized & Self-Signed Release)"
    echo -e "  ${BOLD}[3]${NC} Build Windows Executable (.exe)"
    echo -e "  ${BOLD}[4]${NC} Build Go CLI Node Daemons (Linux, Win, macOS)"
    echo -e "  ${BOLD}[5]${NC} ${GREEN}${BOLD}Build ALL Targets (Full Release Suite)${NC}"
    echo -e "  ${BOLD}[0]${NC} Exit"
    echo ""
    read -p "Select an option [0-5] and press Enter: " choice

    case "$choice" in
        1)
            build_linux
            ;;
        2)
            build_android
            ;;
        3)
            build_windows
            ;;
        4)
            build_go_nodes
            ;;
        5)
            build_all
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
