package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/neuxbane/nxcoder/backend/pkg/api"
	"github.com/neuxbane/nxcoder/backend/pkg/db"
)

func findStaticDir() string {
	candidates := []string{
		".",
		"..",
		"../../",
	}
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(c, "index.html")); err == nil {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	return "."
}

func main() {
	portFlag := flag.String("port", "", "Port to listen on (e.g. 8080)")
	socketFlag := flag.String("socket", "", "Unix domain socket path")
	dataDirFlag := flag.String("data-dir", "", "Persistent SQLite data directory")
	flag.Parse()

	// Resolve environment variables with flag fallback
	socketPath := os.Getenv("NXCODER_SOCKET_PATH")
	if *socketFlag != "" {
		socketPath = *socketFlag
	}

	port := os.Getenv("PORT")
	if *portFlag != "" {
		port = *portFlag
	}
	if port == "" && socketPath == "" {
		port = "8080"
	}

	dataDir := os.Getenv("NXCODER_DATA_DIR")
	if *dataDirFlag != "" {
		dataDir = *dataDirFlag
	}
	if dataDir == "" {
		if configDir, err := os.UserConfigDir(); err == nil {
			dataDir = filepath.Join(configDir, "nxStudio")
		} else {
			home, _ := os.UserHomeDir()
			dataDir = filepath.Join(home, ".config", "nxStudio")
		}
	}
	_ = os.MkdirAll(dataDir, 0755)

	// Initialize pure Go SQLite database
	database, err := db.Open(dataDir)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer database.Close()

	staticDir := findStaticDir()
	server := api.NewServer(database, staticDir, dataDir)
	handler := server.Routes()

	// Handle graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	if socketPath != "" {
		// Clean up existing socket file if present
		_ = os.Remove(socketPath)

		listener, err := net.Listen("unix", socketPath)
		if err != nil {
			log.Fatalf("Failed to listen on Unix domain socket %s: %v", socketPath, err)
		}
		defer listener.Close()
		defer os.Remove(socketPath)

		// Restrict permissions to owner only
		_ = os.Chmod(socketPath, 0600)

		log.Println("=======================================================")
		log.Printf("🚀 nxCoder Go Backend running on Unix Socket: %s\n", socketPath)
		log.Printf("📁 Static Assets Root: %s\n", staticDir)
		log.Printf("🔒 Persistent SQLite DB active in: %s\n", dataDir)
		log.Println("=======================================================")

		go func() {
			<-sigChan
			log.Println("Shutting down nxCoder Go Backend...")
			_ = listener.Close()
			_ = os.Remove(socketPath)
			os.Exit(0)
		}()

		if err := http.Serve(listener, handler); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	} else {
		addr := fmt.Sprintf(":%s", port)
		log.Println("=======================================================")
		log.Printf("🚀 nxCoder Go Backend running on port %s\n", port)
		log.Printf("📁 Static Assets Root: %s\n", staticDir)
		log.Printf("🔒 Persistent SQLite DB active in: %s\n", dataDir)
		log.Println("=======================================================")

		go func() {
			<-sigChan
			log.Println("Shutting down nxCoder Go Backend...")
			os.Exit(0)
		}()

		if err := http.ListenAndServe(addr, handler); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}
}
