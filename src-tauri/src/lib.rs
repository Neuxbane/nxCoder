// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tokio::net::TcpListener;
#[cfg(unix)]
use tokio::net::UnixStream;

#[allow(dead_code)]
struct AppState {
    child: Arc<Mutex<Option<Child>>>,
    socket_path: PathBuf,
}

fn get_data_directory() -> PathBuf {
    if let Some(config_dir) = dirs::config_dir() {
        let dir = config_dir.join("nxStudio");
        let _ = std::fs::create_dir_all(&dir);
        dir
    } else if let Ok(files_dir) = std::env::var("FILES_DIR") {
        let dir = PathBuf::from(files_dir).join("nxStudio");
        let _ = std::fs::create_dir_all(&dir);
        dir
    } else {
        let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
        let dir = home.join(".config").join("nxStudio");
        let _ = std::fs::create_dir_all(&dir);
        dir
    }
}

fn get_socket_path(data_dir: &PathBuf) -> PathBuf {
    let pid = std::process::id();
    data_dir.join(format!("nxstudio-{}.sock", pid))
}

fn find_project_dir() -> PathBuf {
    let mut candidates = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.clone());
        candidates.push(cwd.join(".."));
        candidates.push(cwd.join("../.."));
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent();
        while let Some(parent) = cur {
            candidates.push(parent.to_path_buf());
            cur = parent.parent();
        }
    }

    for dir in candidates {
        if dir.join("nxcoder-backend").exists()
            || dir.join("backend/cmd/server/main.go").exists()
            || (dir.join("index.html").exists() && dir.join("package.json").exists())
        {
            if let Ok(canonical) = dir.canonicalize() {
                return canonical;
            }
            return dir;
        }
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn spawn_backend_server(socket_path: &PathBuf, data_dir: &PathBuf) -> Result<Child, std::io::Error> {
    let project_dir = find_project_dir();
    let go_binary = project_dir.join("nxcoder-backend");
    let go_main = project_dir.join("backend/cmd/server/main.go");

    println!("Starting nxCoder Go Backend Engine on Unix Socket: {:?}", socket_path);
    println!("Project directory: {:?}", project_dir);
    println!("Data directory: {:?}", data_dir);

    if go_binary.exists() {
        println!("Spawning prebuilt Go backend binary: {:?}", go_binary);
        Command::new(&go_binary)
            .current_dir(&project_dir)
            .env("NXCODER_SOCKET_PATH", socket_path)
            .env("NXCODER_DATA_DIR", data_dir)
            .spawn()
    } else if go_main.exists() {
        println!("Spawning Go backend via 'go run ./cmd/server'...");
        Command::new("go")
            .args(["run", "./cmd/server"])
            .current_dir(project_dir.join("backend"))
            .env("NXCODER_SOCKET_PATH", socket_path)
            .env("NXCODER_DATA_DIR", data_dir)
            .spawn()
    } else {
        println!("Spawning Go backend binary from PATH...");
        Command::new("nxcoder-backend")
            .current_dir(&project_dir)
            .env("NXCODER_SOCKET_PATH", socket_path)
            .env("NXCODER_DATA_DIR", data_dir)
            .spawn()
    }
}

#[cfg(unix)]
async fn wait_for_unix_socket(socket_path: &PathBuf, timeout_secs: u64) -> bool {
    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(timeout_secs);

    while start.elapsed() < timeout {
        if socket_path.exists() {
            if let Ok(_stream) = UnixStream::connect(socket_path).await {
                println!("Connected to nxCoder Unix domain socket: {:?}", socket_path);
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

#[cfg(unix)]
async fn start_unix_socket_bridge(socket_path: PathBuf) -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_port = listener.local_addr()?.port();

    println!("IPC Webview Bridge listening on 127.0.0.1:{} -> {:?}", local_port, socket_path);

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut tcp_stream, _)) => {
                    let sock_path = socket_path.clone();
                    tokio::spawn(async move {
                        if let Ok(mut unix_stream) = UnixStream::connect(&sock_path).await {
                            let _ = tokio::io::copy_bidirectional(&mut tcp_stream, &mut unix_stream).await;
                        }
                    });
                }
                Err(err) => {
                    eprintln!("Bridge listener error: {}", err);
                    break;
                }
            }
        }
    });

    Ok(local_port)
}

fn cleanup_process_and_socket(child_lock: &Arc<Mutex<Option<Child>>>, socket_path: &PathBuf) {
    if let Ok(mut lock) = child_lock.lock() {
        if let Some(mut child) = lock.take() {
            println!("Terminating nxCoder Node server (PID: {})...", child.id());
            let _ = child.kill();
            let _ = child.wait();
            println!("Node server terminated.");
        }
    }
    if socket_path.exists() {
        let _ = std::fs::remove_file(socket_path);
        println!("Cleaned up Unix socket: {:?}", socket_path);
    }
}

#[tauri::command]
fn spawn_window(app_handle: tauri::AppHandle, url: String, title: Option<String>) -> Result<(), String> {
    let win_title = title.unwrap_or_else(|| "nxCoder".to_string());
    println!("[Tauri] spawn_window requested with url: {}, title: {}", url, win_title);
    let label = format!("win_{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
    let parsed_url: tauri::Url = url.parse().map_err(|e| {
        let err_msg = format!("Failed to parse URL '{}': {}", url, e);
        eprintln!("[Tauri] {}", err_msg);
        err_msg
    })?;
    
    let win = tauri::WebviewWindowBuilder::new(&app_handle, &label, tauri::WebviewUrl::External(parsed_url))
        .title(&win_title)
        .inner_size(1200.0, 850.0)
        .min_inner_size(360.0, 480.0)
        .resizable(true)
        .build()
        .map_err(|e| {
            let err_msg = format!("Failed to build WebviewWindow '{}': {}", label, e);
            eprintln!("[Tauri] {}", err_msg);
            err_msg
        })?;
    
    let _ = win.show();
    let _ = win.set_focus();
    println!("[Tauri] Successfully spawned window with label: {}", label);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        // Fix WebKitGTK animation stuttering / compositor latency on Linux
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    let data_dir = get_data_directory();
    let socket_path = get_socket_path(&data_dir);

    let child_handle: Arc<Mutex<Option<Child>>> = match spawn_backend_server(&socket_path, &data_dir) {
        Ok(child) => Arc::new(Mutex::new(Some(child))),
        Err(err) => {
            eprintln!("Failed to spawn backend server: {}", err);
            Arc::new(Mutex::new(None))
        }
    };

    let child_handle_clone = Arc::clone(&child_handle);
    let child_handle_exit = Arc::clone(&child_handle);
    let socket_path_exit = socket_path.clone();

    let rt = tokio::runtime::Runtime::new().expect("Failed to initialize Tokio runtime");

    // Wait for Node server to start listening on Unix socket
    #[cfg(unix)]
    let is_ready = rt.block_on(async {
        wait_for_unix_socket(&socket_path, 15).await
    });

    #[cfg(unix)]
    if !is_ready {
        eprintln!("Warning: Unix socket timeout reached.");
    }

    // Start IPC bridge for the internal webview
    let bridge_port = rt.block_on(async {
        #[cfg(unix)]
        { start_unix_socket_bridge(socket_path.clone()).await.unwrap_or(8080) }
        #[cfg(not(unix))]
        { 8080 } // Default port if bridge is not running/needed
    });

    let app = tauri::Builder::default()
        .manage(AppState {
            child: child_handle_clone,
            socket_path,
        })
        .invoke_handler(tauri::generate_handler![spawn_window])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let target_url = format!("http://127.0.0.1:{}", bridge_port);
                if let Ok(parsed_url) = target_url.parse() {
                    let _ = window.navigate(parsed_url);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, event| {
        if let RunEvent::Exit = event {
            cleanup_process_and_socket(&child_handle_exit, &socket_path_exit);
        }
    });
}
