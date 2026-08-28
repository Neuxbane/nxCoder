package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"
	"github.com/neuxbane/nxcoder/backend/pkg/agent"
	"github.com/neuxbane/nxcoder/backend/pkg/tools"
	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow local desktop webview & browsers
	},
}

type Client struct {
	conn         *websocket.Conn
	workspaceID  string
	sessionID    string
	subSessionID string
	targetKey    string
	send         chan []byte
}

type Hub struct {
	clients     map[string]map[*Client]bool // targetKey -> set of clients
	broadcast   chan BroadcastMessage
	register    chan *Client
	unregister  chan *Client
	agentEngine *agent.AgentEngine
	approvalMgr *tools.ApprovalManager
	mu          sync.RWMutex
}

type BroadcastMessage struct {
	TargetKey string
	Payload   []byte
}

type WSIncomingPayload struct {
	Type       string `json:"type"`
	Text       string `json:"text,omitempty"`
	ParentID   *int64 `json:"parentId,omitempty"`
	APIKeyID   string `json:"apiKeyId,omitempty"`
	ApprovalID string `json:"approvalId,omitempty"`
	Action     string `json:"action,omitempty"`
}

func NewHub(agentEngine *agent.AgentEngine, approvalMgr *tools.ApprovalManager) *Hub {
	return &Hub{
		clients:     make(map[string]map[*Client]bool),
		broadcast:   make(chan BroadcastMessage, 256),
		register:    make(chan *Client),
		unregister:  make(chan *Client),
		agentEngine: agentEngine,
		approvalMgr: approvalMgr,
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			if h.clients[client.targetKey] == nil {
				h.clients[client.targetKey] = make(map[*Client]bool)
			}
			h.clients[client.targetKey][client] = true
			h.mu.Unlock()

			// Send current session status immediately
			isGen := h.agentEngine.IsGenerating(client.sessionID)
			status := "idle"
			if isGen {
				status = "generating"
			}
			h.SendDirect(client, map[string]any{
				"type":   "SESSION_STATUS",
				"status": status,
			})

		case client := <-h.unregister:
			h.mu.Lock()
			if clients, ok := h.clients[client.targetKey]; ok {
				if _, ok := clients[client]; ok {
					delete(clients, client)
					close(client.send)
					if len(clients) == 0 {
						delete(h.clients, client.targetKey)
					}
				}
			}
			h.mu.Unlock()

		case message := <-h.broadcast:
			h.mu.RLock()
			if clients, ok := h.clients[message.TargetKey]; ok {
				for client := range clients {
					select {
					case client.send <- message.Payload:
					default:
						close(client.send)
						delete(clients, client)
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) BroadcastJSON(targetKey string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	h.broadcast <- BroadcastMessage{
		TargetKey: targetKey,
		Payload:   data,
	}
}

func (h *Hub) SendDirect(client *Client, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case client.send <- data:
	default:
	}
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")
	subSessionID := chi.URLParam(r, "subSessionID")

	if sessionID == "" {
		http.Error(w, "Session ID required", http.StatusBadRequest)
		return
	}

	targetKey := sessionID
	if subSessionID != "" {
		targetKey = subSessionID
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade failed: %v", err)
		return
	}

	client := &Client{
		conn:         conn,
		workspaceID:  workspaceID,
		sessionID:    sessionID,
		subSessionID: subSessionID,
		targetKey:    targetKey,
		send:         make(chan []byte, 256),
	}

	h.register <- client

	// Pump messages from hub to client
	go func() {
		defer func() {
			h.unregister <- client
			conn.Close()
		}()
		for message := range client.send {
			if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
				break
			}
		}
	}()

	// Read messages from client
	go func() {
		defer func() {
			h.unregister <- client
			conn.Close()
		}()
		for {
			_, msgBytes, err := conn.ReadMessage()
			if err != nil {
				break
			}

			var payload WSIncomingPayload
			if err := json.Unmarshal(msgBytes, &payload); err != nil {
				continue
			}

			switch payload.Type {
			case "USER_MESSAGE":
				go h.agentEngine.ExecuteStreamWithParent(
					context.Background(),
					client.workspaceID,
					client.sessionID,
					payload.Text,
					payload.ParentID,
					payload.APIKeyID,
					h.BroadcastJSON,
				)

			case "RETRY":
				go func() {
					messages, _ := workspace.LoadSessionMessages(h.agentEngine.BaseDir, client.workspaceID, client.sessionID)
					var lastUserPrompt string
					for i := len(messages) - 1; i >= 0; i-- {
						if messages[i].Role == "user" {
							var parts []map[string]any
							_ = json.Unmarshal(messages[i].Parts, &parts)
							for _, p := range parts {
								if txt, ok := p["text"].(string); ok && txt != "" {
									lastUserPrompt = txt
									break
								}
							}
							if lastUserPrompt != "" {
								break
							}
						}
					}

					if lastUserPrompt != "" {
						h.agentEngine.ExecuteStream(
							context.Background(),
							client.workspaceID,
							client.sessionID,
							lastUserPrompt,
							"",
							h.BroadcastJSON,
						)
					} else {
						h.BroadcastJSON(client.sessionID, map[string]any{
							"type":    "ERROR",
							"message": "No user message history available to retry.",
						})
					}
				}()

			case "CANCEL":
				h.agentEngine.CancelGeneration(client.sessionID)
				h.BroadcastJSON(client.sessionID, map[string]any{"type": "DONE"})

			case "COMMAND_APPROVAL_RESPONSE":
				if payload.ApprovalID != "" && payload.Action != "" {
					h.approvalMgr.ResolveApproval(payload.ApprovalID, payload.Action)
				}

			case "TOOL_APPROVAL_RESPONSE":
				if payload.ApprovalID != "" && payload.Action != "" {
					h.approvalMgr.ResolveApproval(payload.ApprovalID, payload.Action)
				}
			}
		}
	}()
}
